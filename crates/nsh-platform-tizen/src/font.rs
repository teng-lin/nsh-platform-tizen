//! What the page needs to register a font file (`FontFace`): its family
//! name, as NSH's core reads it (the typographic family; WOFF and WOFF2
//! unwrapped by `nsh_core::font_data`), and its weight and style from
//! `ttf-parser`, the reader nsh-core already links (no extra code in the
//! module). A collection (TTC) gives its first font.

/// A font file's face, as CSS names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Face {
    /// The family (the typographic family, else the family).
    pub family: String,
    /// CSS `font-weight` (`OS/2` `usWeightClass`).
    pub weight: u16,
    /// Italic or oblique.
    pub italic: bool,
}

/// The face of the TrueType / OpenType / WOFF / WOFF2 file `data`. Its
/// family is read as `nsh_core::font_family` reads it (the typographic
/// family, else the family), from one unwrapping of the file.
pub fn parse(data: &[u8]) -> Result<Face, String> {
    let unwrapped = nsh_core::font_data(data)?;
    let face = ttf_parser::Face::parse(&unwrapped, 0).map_err(|e| format!("not a font: {e}"))?;
    let name = |id| {
        face.names()
            .into_iter()
            .filter(|n| n.name_id == id && n.is_unicode())
            .find_map(|n| n.to_string())
    };
    let family = name(ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| name(ttf_parser::name_id::FAMILY))
        .ok_or("the font has no family name")?;
    Ok(Face {
        family,
        weight: face.weight().to_number(),
        italic: face.is_italic() || face.is_oblique(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn be16(v: u16) -> [u8; 2] {
        v.to_be_bytes()
    }

    /// The tables of a minimal font `ttf-parser` accepts: `head`, `hhea`,
    /// `maxp`, `name` (family `family`, Windows UTF-16BE) and `OS/2`
    /// (`weight`, the italic bit).
    fn tables(family: &str, weight: u16, italic: bool) -> Vec<([u8; 4], Vec<u8>)> {
        let mut head = vec![0u8; 54];
        head[0..4].copy_from_slice(&[0, 1, 0, 0]);
        head[12..16].copy_from_slice(&0x5F0F3CF5u32.to_be_bytes());
        head[18..20].copy_from_slice(&be16(1000));
        let mut hhea = vec![0u8; 36];
        hhea[0..4].copy_from_slice(&[0, 1, 0, 0]);
        hhea[34..36].copy_from_slice(&be16(1));
        let mut maxp = vec![0, 0, 0x50, 0];
        maxp.extend(be16(1));
        let utf16: Vec<u8> = family.encode_utf16().flat_map(u16::to_be_bytes).collect();
        let mut name = Vec::new();
        for v in [0u16, 1, 6 + 12] {
            name.extend(be16(v));
        }
        for v in [3u16, 1, 0x409, 1, utf16.len() as u16, 0] {
            name.extend(be16(v));
        }
        name.extend(&utf16);
        // Version 4's 96 bytes.
        let mut os2 = vec![0u8; 96];
        os2[0..2].copy_from_slice(&be16(4));
        os2[4..6].copy_from_slice(&be16(weight));
        os2[62..64].copy_from_slice(&be16(u16::from(italic)));
        vec![
            (*b"OS/2", os2),
            (*b"head", head),
            (*b"hhea", hhea),
            (*b"maxp", maxp),
            (*b"name", name),
        ]
    }

    /// An sfnt with `tables`, its table offsets counted from `base` (where
    /// it starts in the file: a collection's fonts are not at 0).
    fn sfnt(tables: &[([u8; 4], Vec<u8>)], base: usize) -> Vec<u8> {
        let mut out = vec![0, 1, 0, 0];
        out.extend(be16(tables.len() as u16));
        out.extend([0u8; 6]);
        let mut offset = base + 12 + tables.len() * 16;
        let mut bodies = Vec::new();
        for (tag, body) in tables {
            out.extend(tag);
            out.extend([0u8; 4]);
            out.extend((offset as u32).to_be_bytes());
            out.extend((body.len() as u32).to_be_bytes());
            let padded = body.len().next_multiple_of(4);
            offset += padded;
            bodies.extend(body);
            bodies.resize(bodies.len() + padded - body.len(), 0);
        }
        out.extend(bodies);
        out
    }

    pub(crate) fn font(family: &str, weight: u16, italic: bool) -> Vec<u8> {
        sfnt(&tables(family, weight, italic), 0)
    }

    /// A collection of one font: offsets are counted from the file's start.
    fn collection(family: &str) -> Vec<u8> {
        let mut out = b"ttcf".to_vec();
        out.extend([0, 1, 0, 0]);
        out.extend(1u32.to_be_bytes());
        out.extend(16u32.to_be_bytes());
        out.extend(sfnt(&tables(family, 300, false), 16));
        out
    }

    /// A WOFF 1.0 file of the same tables, stored uncompressed.
    fn woff(family: &str) -> Vec<u8> {
        let tables = tables(family, 500, true);
        let font = font(family, 500, true);
        let mut dir = Vec::new();
        let mut bodies = Vec::new();
        let mut offset = 44 + tables.len() * 20;
        for (tag, body) in &tables {
            dir.extend(tag);
            dir.extend((offset as u32).to_be_bytes());
            dir.extend((body.len() as u32).to_be_bytes());
            dir.extend((body.len() as u32).to_be_bytes());
            dir.extend(0u32.to_be_bytes());
            let padded = body.len().next_multiple_of(4);
            offset += padded;
            bodies.extend(body);
            bodies.resize(bodies.len() + padded - body.len(), 0);
        }
        let mut out = b"wOFF".to_vec();
        out.extend([0, 1, 0, 0]);
        out.extend((offset as u32).to_be_bytes());
        out.extend(be16(tables.len() as u16));
        out.extend(be16(0));
        out.extend((font.len() as u32).to_be_bytes());
        out.extend([0u8; 24]);
        out.extend(dir);
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
    }

    #[test]
    fn reads_a_collections_first_font() {
        let face = parse(&collection("Guide Mono")).unwrap();
        assert_eq!((face.family.as_str(), face.weight), ("Guide Mono", 300));
    }

    #[test]
    fn reads_woff() {
        let face = parse(&woff("Guide Serif")).unwrap();
        assert_eq!(
            (face.family.as_str(), face.weight, face.italic),
            ("Guide Serif", 500, true)
        );
    }

    #[test]
    fn rejects_what_is_not_a_font() {
        assert!(parse(b"GIF89a").is_err());
        assert!(parse(&[0, 1, 0, 0, 0, 1]).is_err());
    }
}
