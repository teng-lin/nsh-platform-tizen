//! What the page needs to register a font file (`FontFace`): its family
//! name, weight and style, read from the file's `name`, `OS/2` and `head`
//! tables. A small reader of its own instead of a font crate: the module's
//! size is the TV's launch time (about 3 s per MB to compile).

/// A font file's face, as CSS names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Face {
    /// The family (the typographic family, else the family).
    pub family: String,
    /// CSS `font-weight` (`OS/2` `usWeightClass`; 400 without the table).
    pub weight: u16,
    /// Italic or oblique.
    pub italic: bool,
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*data.get(at)?, *data.get(at + 1)?]))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// The table `tag`'s bytes.
fn table<'a>(data: &'a [u8], tag: &[u8; 4]) -> Option<&'a [u8]> {
    let count = usize::from(u16_at(data, 4)?);
    (0..count).find_map(|i| {
        let record = 12 + i * 16;
        if data.get(record..record + 4)? != tag {
            return None;
        }
        let offset = u32_at(data, record + 8)? as usize;
        let len = u32_at(data, record + 12)? as usize;
        data.get(offset..offset.checked_add(len)?)
    })
}

/// Name `id` of the `name` table: a Windows or Unicode record (UTF-16BE),
/// else a Macintosh Roman one read as Latin-1.
fn name(table: &[u8], id: u16) -> Option<String> {
    let count = usize::from(u16_at(table, 2)?);
    let strings = usize::from(u16_at(table, 4)?);
    let mut mac = None;
    for i in 0..count {
        let record = 6 + i * 12;
        let platform = u16_at(table, record)?;
        if u16_at(table, record + 6)? != id {
            continue;
        }
        let len = usize::from(u16_at(table, record + 8)?);
        let offset = strings + usize::from(u16_at(table, record + 10)?);
        let bytes = table.get(offset..offset + len)?;
        match platform {
            0 | 3 => {
                let units: Vec<u16> = (0..bytes.len() / 2)
                    .map(|i| u16::from_be_bytes([bytes[2 * i], bytes[2 * i + 1]]))
                    .collect();
                let text = String::from_utf16_lossy(&units);
                if !text.is_empty() {
                    return Some(text);
                }
            }
            1 if mac.is_none() => mac = Some(bytes.iter().map(|&b| char::from(b)).collect()),
            _ => {}
        }
    }
    mac.filter(|s: &String| !s.is_empty())
}

/// The face of the TrueType / OpenType file `data` (a collection's first).
pub fn parse(data: &[u8]) -> Result<Face, String> {
    let data = match data.get(..4) {
        Some(b"ttcf") => {
            let first = u32_at(data, 12).ok_or("a truncated font collection")? as usize;
            data.get(first..).ok_or("a truncated font collection")?
        }
        Some([0, 1, 0, 0] | b"OTTO" | b"true") => data,
        _ => return Err("not a TrueType or OpenType font".to_owned()),
    };
    let names = table(data, b"name").ok_or("the font has no name table")?;
    let family = name(names, 16)
        .or_else(|| name(names, 1))
        .ok_or("the font has no family name")?;
    let os2 = table(data, b"OS/2");
    let weight = os2
        .and_then(|t| u16_at(t, 4))
        .filter(|w| (1..=1000).contains(w))
        .unwrap_or(400);
    let italic = os2.and_then(|t| u16_at(t, 62)).is_some_and(|s| s & 1 != 0)
        || table(data, b"head")
            .and_then(|t| u16_at(t, 44))
            .is_some_and(|s| s & 2 != 0);
    Ok(Face {
        family,
        weight,
        italic,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A font file with only the tables [`parse`] reads: `name` with the
    /// family `family` (Windows, UTF-16BE) and a Macintosh record, `OS/2`
    /// with `weight` and the italic bit.
    pub(crate) fn font(family: &str, weight: u16, italic: bool) -> Vec<u8> {
        let utf16: Vec<u8> = family.encode_utf16().flat_map(u16::to_be_bytes).collect();
        let mac = b"Mac Name".to_vec();
        let mut name = Vec::new();
        name.extend(0u16.to_be_bytes()); // format
        name.extend(2u16.to_be_bytes()); // count
        name.extend((6u16 + 2 * 12).to_be_bytes()); // string offset
        for (platform, encoding, len, offset) in [
            (1u16, 0u16, mac.len() as u16, 0u16),
            (3, 1, utf16.len() as u16, mac.len() as u16),
        ] {
            for v in [platform, encoding, 0, 1, len, offset] {
                name.extend(v.to_be_bytes());
            }
        }
        name.extend(&mac);
        name.extend(&utf16);
        let mut os2 = vec![0u8; 78];
        os2[4..6].copy_from_slice(&weight.to_be_bytes());
        os2[62..64].copy_from_slice(&u16::from(italic).to_be_bytes());
        let tables: [(&[u8; 4], &[u8]); 2] = [(b"OS/2", &os2), (b"name", &name)];
        let mut out = vec![0, 1, 0, 0];
        out.extend((tables.len() as u16).to_be_bytes());
        out.extend([0u8; 6]);
        let mut offset = 12 + tables.len() * 16;
        let mut bodies = Vec::new();
        for (tag, body) in tables {
            out.extend(tag);
            out.extend([0u8; 4]);
            out.extend((offset as u32).to_be_bytes());
            out.extend((body.len() as u32).to_be_bytes());
            offset += body.len();
            bodies.extend_from_slice(body);
        }
        out.extend(bodies);
        out
    }

    #[test]
    fn reads_family_weight_and_style() {
        let face = parse(&font("Guide Sans", 700, true)).unwrap();
        assert_eq!(
            face,
            Face {
                family: "Guide Sans".into(),
                weight: 700,
                italic: true
            }
        );
        assert_eq!(parse(&font("Guide Sans", 0, false)).unwrap().weight, 400);
    }

    #[test]
    fn rejects_what_is_not_a_font() {
        assert!(parse(b"GIF89a").is_err());
        assert!(parse(&[0, 1, 0, 0, 0, 1]).is_err());
    }
}
