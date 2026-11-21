//! Probe: SQLite through rusqlite in the browser Wasm target, for Tizen 5.5.

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_now_ms() -> f64;
    fn host_random(buf: *mut u8, len: usize);
}

#[unsafe(export_name = "rust_sqlite_wasm_host_sleep")]
pub extern "C" fn sleep(_seconds: u64, _nanoseconds: u32) {}

/// # Safety
/// `buf` is writable for `len` bytes.
#[unsafe(export_name = "rust_sqlite_wasm_host_random")]
pub unsafe extern "C" fn random(buf: *mut u8, len: usize) -> usize {
    // SAFETY: the host fills exactly `len` bytes at `buf`.
    unsafe { host_random(buf, len) };
    len
}

/// # Safety
/// `out` is writable.
#[unsafe(export_name = "rust_sqlite_wasm_host_epoch_timestamp_in_ms")]
pub unsafe extern "C" fn epoch(out: *mut i64) -> i32 {
    // SAFETY: caller contract.
    unsafe { out.write(host_now_ms() as i64) };
    0
}

/// # Safety
/// `buf` is writable for `len` bytes.
#[unsafe(export_name = "rust_sqlite_wasm_host_fill_entropy")]
pub unsafe extern "C" fn entropy(buf: *mut u8, len: usize) -> i32 {
    // SAFETY: the host fills exactly `len` bytes at `buf`.
    unsafe { host_random(buf, len) };
    0
}

#[unsafe(export_name = "rust_sqlite_wasm_host_localtime")]
pub extern "C" fn localtime(_unix_seconds: i64, _out: *mut u8) -> i32 {
    1 // Unsupported: UTC only in the probe.
}

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

use rsqlite_vfs::{
    AccessMode, LockLevel, OpenOptions, OpenedFile, OsCallback, SQLiteIoMethods, SQLiteVfs,
    SyncOptions, VfsError, VfsErrorCode, VfsFile, VfsResult, VfsStore,
};
use rusqlite::{Connection, OpenFlags};

/// The unit the page store writes to IndexedDB.
const CHUNK: usize = 64 * 1024;
const MAIN: &str = "main.db";
const COPY: &str = "copy.db";
const VFS: &str = "pagevfs";

type Bytes = Rc<RefCell<Vec<u8>>>;

thread_local! {
    static FILES: RefCell<HashMap<String, Bytes>> = RefCell::new(HashMap::new());
    /// Chunks of MAIN written since the last flush.
    static DIRTY: RefCell<BTreeSet<u32>> = const { RefCell::new(BTreeSet::new()) };
    static LIST: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static MAINDB: RefCell<Option<Connection>> = const { RefCell::new(None) };
    static COPYDB: RefCell<Option<Connection>> = const { RefCell::new(None) };
    static NEXT_ROW: std::cell::Cell<i32> = const { std::cell::Cell::new(0) };
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct Os;
impl OsCallback for Os {
    fn sleep(&self, _d: std::time::Duration) {}
    fn random(&self, buf: &mut [u8]) -> usize {
        // SAFETY: the host fills exactly `len` bytes at `buf`.
        unsafe { host_random(buf.as_mut_ptr(), buf.len()) };
        buf.len()
    }
    fn epoch_timestamp_in_ms(&self) -> VfsResult<i64> {
        // SAFETY: no arguments.
        Ok(unsafe { host_now_ms() } as i64)
    }
}

struct PageFile {
    data: Bytes,
    tracked: bool,
}

fn mark(offset: u64, len: usize) {
    if len == 0 {
        return;
    }
    let first = (offset as usize / CHUNK) as u32;
    let last = ((offset as usize + len - 1) / CHUNK) as u32;
    DIRTY.with(|d| d.borrow_mut().extend(first..=last));
}

impl VfsFile for PageFile {
    fn read(&mut self, buf: &mut [u8], offset: u64) -> VfsResult<usize> {
        let data = self.data.borrow();
        let offset = offset as usize;
        if data.len() <= offset {
            return Ok(0);
        }
        let n = buf.len().min(data.len() - offset);
        buf[..n].copy_from_slice(&data[offset..offset + n]);
        Ok(n)
    }
    fn write(&mut self, buf: &[u8], offset: u64) -> VfsResult<()> {
        let mut data = self.data.borrow_mut();
        let end = offset as usize + buf.len();
        if end > data.len() {
            data.resize(end, 0);
        }
        data[offset as usize..end].copy_from_slice(buf);
        if self.tracked {
            mark(offset, buf.len());
        }
        Ok(())
    }
    fn truncate(&mut self, size: u64) -> VfsResult<()> {
        self.data.borrow_mut().truncate(size as usize);
        Ok(())
    }
    fn sync(&mut self, _o: SyncOptions) -> VfsResult<()> {
        Ok(())
    }
    fn lock(&mut self, _l: LockLevel) -> VfsResult<()> {
        Ok(())
    }
    fn unlock(&mut self, _l: LockLevel) -> VfsResult<()> {
        Ok(())
    }
    fn check_reserved_lock(&self) -> VfsResult<bool> {
        Ok(false)
    }
    fn size(&self) -> VfsResult<u64> {
        Ok(self.data.borrow().len() as u64)
    }
}

#[derive(Default)]
struct AppData {
    error: RefCell<Option<VfsError>>,
}

struct Store;
impl VfsStore for Store {
    type File = PageFile;
    type AppData = AppData;
    fn record_error(data: &AppData, e: VfsError) {
        data.error.replace(Some(e));
    }
    fn last_error(data: &AppData) -> Option<VfsError> {
        data.error.borrow().clone()
    }
    fn open_file(_a: &AppData, request: rsqlite_vfs::OpenRequest<'_>) -> VfsResult<OpenedFile<PageFile>> {
        let options = request.options;
        let Some(name) = request.filename.map(|f| f.path().to_owned()) else {
            return Ok(OpenedFile { file: PageFile { data: Rc::default(), tracked: false }, access: options.access() });
        };
        let data = FILES.with(|f| {
            let mut f = f.borrow_mut();
            match f.get(&name) {
                Some(d) => Ok(d.clone()),
                None if options.create() => {
                    let d: Bytes = Rc::default();
                    f.insert(name.clone(), d.clone());
                    Ok(d)
                }
                None => Err(VfsError::new(VfsErrorCode::CantOpen, "not found".into())),
            }
        })?;
        Ok(OpenedFile { file: PageFile { data, tracked: name == MAIN }, access: options.access() })
    }
    fn access(_a: &AppData, file: &str, _m: AccessMode) -> VfsResult<bool> {
        Ok(FILES.with(|f| f.borrow().contains_key(file)))
    }
    fn full_pathname(_a: &AppData, name: &str) -> VfsResult<String> {
        Ok(name.into())
    }
    fn delete_file(_a: &AppData, file: &str, _s: bool) -> VfsResult<()> {
        FILES.with(|f| f.borrow_mut().remove(file));
        Ok(())
    }
    fn close_file(_a: &AppData, _n: Option<&str>, _f: PageFile, _o: OpenOptions) -> VfsResult<()> {
        Ok(())
    }
}
struct Io;
impl SQLiteIoMethods for Io {
    type Store = Store;
}
struct Vfs;
impl SQLiteVfs<Io> for Vfs {
    type Os = Os;
    fn os(_: &AppData) -> &Os {
        &Os
    }
}

fn open(name: &str) -> rusqlite::Result<Connection> {
    let c = Connection::open_with_flags_and_vfs(name, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE, VFS)?;
    // The rollback journal stays in memory; durability comes from flushing
    // committed chunks to IndexedDB.
    c.execute_batch("pragma journal_mode=memory; pragma synchronous=off;")?;
    Ok(c)
}

/// Registers the VFS and opens the main database (empty or loaded).
#[unsafe(no_mangle)]
pub extern "C" fn init() -> i32 {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let mut ok = true;
    ONCE.call_once(|| {
        // SAFETY: one thread; the registration lives for the module's life.
        ok = unsafe { rsqlite_vfs::register_vfs::<Io, Vfs>(VFS, AppData::default(), false) }
            .map(std::mem::forget)
            .is_ok();
    });
    if !ok {
        return -2;
    }
    match open(MAIN) {
        Ok(c) => {
            MAINDB.with(|m| *m.borrow_mut() = Some(c));
            0
        }
        Err(_) => -1,
    }
}

const SCHEMA: &str = "create table if not exists programs(channel integer, start integer, stop integer, title text, category text);
create index if not exists programs_by_channel on programs(channel, start);
create index if not exists programs_by_stop on programs(stop);
create table if not exists channels(id integer primary key, name text, grp integer, logo text, stream text, favorite integer default 0);";


fn insert_programs(tx: &Connection, from: i32, to: i32, channels: i32, generation: i32) -> rusqlite::Result<()> {
    let mut p = tx.prepare_cached("insert into programs values (?1, ?2, ?3, ?4, ?5)")?;
    for i in from..to {
        let channel = i % channels.max(1);
        let start = 1_800_000_000i64 + i64::from(i / channels.max(1)) * 1800;
        p.execute(rusqlite::params![channel, start, start + 1800,
            format!("Example program {} part {} v{generation}", i % 997, i % 13), "News"])?;
    }
    Ok(())
}

/// Builds the guide-like database in MAIN; returns its size, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn build(channels: i32, programs: i32) -> f64 {
    MAINDB.with(|m| {
        let mut m = m.borrow_mut();
        let c = m.as_mut().expect("init");
        let mut run = || -> rusqlite::Result<f64> {
            c.execute_batch(SCHEMA)?;
            let tx = c.transaction()?;
            {
                let mut ch = tx.prepare("insert into channels(id, name, grp, logo, stream) values (?1, ?2, ?3, ?4, ?5)")?;
                for i in 0..channels {
                    ch.execute(rusqlite::params![i, format!("Example channel {i} HD"), i % 101,
                        format!("http://img.example.com/logos/{i}.png"), format!("{{\"t\":\"xtream\",\"stream_id\":{i}}}")])?;
                }
                insert_programs(&tx, 0, programs, channels, 0)?;
            }
            tx.commit()?;
            Ok(file_size())
        };
        run().unwrap_or(-1.0)
    })
}

/// A small change: toggles one channel's favorite flag.
#[unsafe(no_mangle)]
pub extern "C" fn toggle_favorite(channel: i32) -> i32 {
    MAINDB.with(|m| {
        m.borrow().as_ref().expect("init")
            .execute("update channels set favorite = 1 - favorite where id = ?1", [channel])
            .map_or(-1, |n| n as i32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn file_size() -> f64 {
    FILES.with(|f| f.borrow().get(MAIN).map_or(0, |d| d.borrow().len()) as f64)
}

/// Freezes the dirty chunk list for reading; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn dirty_take() -> i32 {
    let list: Vec<u32> = DIRTY.with(|d| std::mem::take(&mut *d.borrow_mut()).into_iter().collect());
    let n = list.len() as i32;
    LIST.with(|l| *l.borrow_mut() = list);
    n
}

#[unsafe(no_mangle)]
pub extern "C" fn dirty_index(i: i32) -> i32 {
    LIST.with(|l| l.borrow()[i as usize] as i32)
}

/// Copies chunk `index` of MAIN into a scratch buffer; returns its address
/// (length: `chunk_len`).
#[unsafe(no_mangle)]
pub extern "C" fn chunk_ptr(index: i32) -> *const u8 {
    FILES.with(|f| {
        let f = f.borrow();
        let data = f[MAIN].borrow();
        let start = (index as usize * CHUNK).min(data.len());
        let end = (start + CHUNK).min(data.len());
        SCRATCH.with(|s| {
            let mut s = s.borrow_mut();
            s.clear();
            s.extend_from_slice(&data[start..end]);
            s.as_ptr()
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn chunk_len() -> i32 {
    SCRATCH.with(|s| s.borrow().len() as i32)
}

/// Prepares MAIN to receive `size` bytes chunk by chunk (before `init`).
#[unsafe(no_mangle)]
pub extern "C" fn load_begin(size: f64) {
    FILES.with(|f| {
        f.borrow_mut().insert(MAIN.into(), Rc::new(RefCell::new(vec![0; size as usize])));
    });
}

/// Where chunk `index` of MAIN goes (`len` bytes).
#[unsafe(no_mangle)]
pub extern "C" fn load_chunk(index: i32) -> *mut u8 {
    FILES.with(|f| f.borrow()[MAIN].borrow_mut()[index as usize * CHUNK..].as_mut_ptr())
}

/// Starts a guide publish on a copy of MAIN: copies the file, opens it and
/// begins replacing its programs.
#[unsafe(no_mangle)]
pub extern "C" fn publish_begin() -> i32 {
    FILES.with(|f| {
        let mut f = f.borrow_mut();
        let copy = f[MAIN].borrow().clone();
        f.insert(COPY.into(), Rc::new(RefCell::new(copy)));
    });
    let run = || -> rusqlite::Result<()> {
        let c = open(COPY)?;
        c.execute_batch("begin; delete from programs;")?;
        COPYDB.with(|d| *d.borrow_mut() = Some(c));
        NEXT_ROW.with(|n| n.set(0));
        Ok(())
    };
    run().map_or(-1, |()| 0)
}

/// Inserts the next `n` of `total` programs into the copy; returns how many remain.
#[unsafe(no_mangle)]
pub extern "C" fn publish_slice(n: i32, total: i32, channels: i32) -> i32 {
    COPYDB.with(|d| {
        let d = d.borrow();
        let c = d.as_ref().expect("publish_begin");
        let from = NEXT_ROW.with(|r| r.get());
        let to = (from + n).min(total);
        if insert_programs(c, from, to, channels, 1).is_err() {
            return -1;
        }
        NEXT_ROW.with(|r| r.set(to));
        total - to
    })
}

/// Commits the copy and makes it MAIN; every chunk is then dirty.
#[unsafe(no_mangle)]
pub extern "C" fn publish_finish() -> i32 {
    let committed = COPYDB.with(|d| d.borrow_mut().take().map(|c| c.execute_batch("commit")));
    if !matches!(committed, Some(Ok(()))) {
        return -1;
    }
    MAINDB.with(|m| *m.borrow_mut() = None);
    FILES.with(|f| {
        let mut f = f.borrow_mut();
        let copy = f.remove(COPY).expect("copy");
        f.insert(MAIN.into(), copy);
    });
    let chunks = (file_size() as usize).div_ceil(CHUNK) as u32;
    DIRTY.with(|d| d.borrow_mut().extend(0..chunks));
    match open(MAIN) {
        Ok(c) => {
            MAINDB.with(|m| *m.borrow_mut() = Some(c));
            0
        }
        Err(_) => -2,
    }
}

/// `n` guide-window queries on MAIN; returns rows seen.
#[unsafe(no_mangle)]
pub extern "C" fn queries(n: i32) -> f64 {
    MAINDB.with(|m| {
        let m = m.borrow();
        let c = m.as_ref().expect("init");
        let mut q = c.prepare_cached("select title, start, stop from programs where channel = ?1 and start < ?2 and stop > ?3 order by start").unwrap();
        let mut rows = 0;
        for i in 0..n {
            let t = 1_800_000_000i64 + 36_000;
            let mut r = q.query(rusqlite::params![i * 7 % 7000, t + 14_400, t]).unwrap();
            while r.next().unwrap().is_some() {
                rows += 1;
            }
        }
        rows as f64
    })
}

/// Programs in MAIN, and the version of their titles (0 built, 1 published).
#[unsafe(no_mangle)]
pub extern "C" fn count() -> f64 {
    MAINDB.with(|m| {
        m.borrow().as_ref().expect("init")
            .query_row("select count(*) from programs", [], |r| r.get::<_, i64>(0))
            .map_or(-1.0, |n| n as f64)
    })
}
