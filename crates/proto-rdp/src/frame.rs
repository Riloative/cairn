//! Dirty-rectangle tracking and the binary messages sent to the session view.
//!
//! Every message starts with a tag byte. A frame (tag 0) carries every rectangle that
//! changed since the last flush; a pointer (tag 1) carries the cursor bitmap:
//!
//! ```text
//! 0, u16 desktop_width, u16 desktop_height, u16 count,
//!    count × { u16 x, u16 y, u16 w, u16 h, w·h·4 bytes RGBA }
//! 1, u16 width, u16 height, u16 hotspot_x, u16 hotspot_y, width·height·4 bytes RGBA
//! ```
//!
//! All integers are little-endian. The desktop size travels with every frame so the
//! view can follow a resize without ordering it against the JSON event channel.

pub const TAG_FRAME: u8 = 0;
pub const TAG_POINTER: u8 = 1;

/// A rectangle in desktop pixels, `x + w` and `y + h` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Rect {
    fn right(self) -> u32 {
        u32::from(self.x) + u32::from(self.w)
    }

    fn bottom(self) -> u32 {
        u32::from(self.y) + u32::from(self.h)
    }

    fn area(self) -> u64 {
        u64::from(self.w) * u64::from(self.h)
    }

    fn union(self, o: Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        // Both rights fit in u16 because they are clipped to the desktop.
        let w = (self.right().max(o.right()) - u32::from(x)) as u16;
        let h = (self.bottom().max(o.bottom()) - u32::from(y)) as u16;
        Rect { x, y, w, h }
    }

    /// Overlapping or sharing an edge.
    fn touches(self, o: Rect) -> bool {
        u32::from(self.x) <= o.right()
            && u32::from(o.x) <= self.right()
            && u32::from(self.y) <= o.bottom()
            && u32::from(o.y) <= self.bottom()
    }
}

/// Above this many separate rectangles, the region collapses to its bounding box.
const MAX_RECTS: usize = 32;

/// The changed area since the last flush.
#[derive(Debug, Default)]
pub struct DirtyRegion {
    rects: Vec<Rect>,
}

impl DirtyRegion {
    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }

    pub fn clear(&mut self) {
        self.rects.clear();
    }

    /// Mark a rectangle as changed, clipped to the desktop. Touching rectangles merge when
    /// their union wastes little area, so a typing caret or a progress bar does not grow
    /// into a full-screen repaint.
    pub fn add(&mut self, rect: Rect, desktop_w: u16, desktop_h: u16) {
        let Some(mut rect) = clip(rect, desktop_w, desktop_h) else {
            return;
        };
        let mut i = 0;
        while i < self.rects.len() {
            let other = self.rects[i];
            let union = rect.union(other);
            if rect.touches(other) && union.area() * 4 <= (rect.area() + other.area()) * 5 {
                rect = union;
                self.rects.swap_remove(i);
                i = 0;
            } else {
                i += 1;
            }
        }
        self.rects.push(rect);
        if self.rects.len() > MAX_RECTS {
            let all = self.rects.iter().copied().reduce(Rect::union);
            self.rects = all.into_iter().collect();
        }
    }

    /// Everything changed (new desktop size, reactivation).
    pub fn add_all(&mut self, desktop_w: u16, desktop_h: u16) {
        self.rects.clear();
        self.add(
            Rect {
                x: 0,
                y: 0,
                w: desktop_w,
                h: desktop_h,
            },
            desktop_w,
            desktop_h,
        );
    }

    pub fn rects(&self) -> &[Rect] {
        &self.rects
    }
}

fn clip(r: Rect, desktop_w: u16, desktop_h: u16) -> Option<Rect> {
    if r.x >= desktop_w || r.y >= desktop_h || r.w == 0 || r.h == 0 {
        return None;
    }
    let w = (r.right().min(u32::from(desktop_w)) - u32::from(r.x)) as u16;
    let h = (r.bottom().min(u32::from(desktop_h)) - u32::from(r.y)) as u16;
    Some(Rect { w, h, ..r })
}

/// Encode the region's pixels from an RGBA framebuffer of `desktop_w × desktop_h`
/// (`stride` bytes per row). Alpha is forced opaque.
pub fn encode(
    region: &DirtyRegion,
    pixels: &[u8],
    stride: usize,
    desktop_w: u16,
    desktop_h: u16,
) -> Vec<u8> {
    let payload: usize = region.rects.iter().map(|r| r.area() as usize * 4 + 8).sum();
    let mut out = Vec::with_capacity(7 + payload);
    out.push(TAG_FRAME);
    out.extend_from_slice(&desktop_w.to_le_bytes());
    out.extend_from_slice(&desktop_h.to_le_bytes());
    out.extend_from_slice(&(region.rects.len() as u16).to_le_bytes());
    for r in &region.rects {
        for v in [r.x, r.y, r.w, r.h] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let row_bytes = usize::from(r.w) * 4;
        for row in usize::from(r.y)..usize::from(r.y) + usize::from(r.h) {
            let start = row * stride + usize::from(r.x) * 4;
            let Some(src) = pixels.get(start..start + row_bytes) else {
                // A short buffer would be a decoder bug; pad rather than misalign the message.
                out.resize(out.len() + row_bytes, 0);
                continue;
            };
            let at = out.len();
            out.extend_from_slice(src);
            for px in out[at..].as_chunks_mut::<4>().0 {
                px[3] = 0xFF;
            }
        }
    }
    out
}

/// Encode a cursor bitmap (straight-alpha RGBA).
pub fn encode_pointer(width: u16, height: u16, hot_x: u16, hot_y: u16, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + rgba.len());
    out.push(TAG_POINTER);
    for v in [width, height, hot_x, hot_y] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(rgba);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: u16, y: u16, w: u16, h: u16) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn merges_adjacent_rects_and_keeps_distant_ones() {
        let mut d = DirtyRegion::default();
        d.add(r(0, 0, 10, 10), 100, 100);
        d.add(r(10, 0, 10, 10), 100, 100);
        assert_eq!(d.rects(), &[r(0, 0, 20, 10)]);
        d.add(r(80, 80, 5, 5), 100, 100);
        assert_eq!(d.rects().len(), 2);
    }

    #[test]
    fn does_not_merge_when_the_union_wastes_area() {
        let mut d = DirtyRegion::default();
        // Touching at a corner only: the union would be 4× their combined area.
        d.add(r(0, 0, 10, 10), 100, 100);
        d.add(r(10, 10, 10, 10), 100, 100);
        assert_eq!(d.rects().len(), 2);
    }

    #[test]
    fn clips_to_the_desktop_and_drops_empty_rects() {
        let mut d = DirtyRegion::default();
        d.add(r(90, 90, 50, 50), 100, 100);
        d.add(r(200, 0, 5, 5), 100, 100);
        d.add(r(0, 0, 0, 5), 100, 100);
        assert_eq!(d.rects(), &[r(90, 90, 10, 10)]);
    }

    #[test]
    fn collapses_many_rects_into_their_bounding_box() {
        let mut d = DirtyRegion::default();
        for i in 0..40u16 {
            d.add(r(i * 20, (i % 2) * 50, 2, 2), 1000, 1000);
        }
        assert!(d.rects().len() <= MAX_RECTS);
    }

    #[test]
    fn encodes_header_and_cropped_rows() {
        // 3×2 desktop, pixel value = index.
        let pixels: Vec<u8> = (0..24).collect();
        let mut d = DirtyRegion::default();
        d.add(r(1, 0, 2, 2), 3, 2);
        let msg = encode(&d, &pixels, 12, 3, 2);
        assert_eq!(&msg[..7], &[TAG_FRAME, 3, 0, 2, 0, 1, 0]);
        assert_eq!(&msg[7..15], &[1, 0, 0, 0, 2, 0, 2, 0]);
        // Row 0 pixels 1–2, then row 1 pixels 1–2, alpha forced to 255.
        assert_eq!(
            &msg[15..],
            &[4, 5, 6, 255, 8, 9, 10, 255, 16, 17, 18, 255, 20, 21, 22, 255]
        );
    }

    #[test]
    fn encodes_pointer_with_hotspot() {
        let msg = encode_pointer(2, 1, 1, 0, &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&msg[..9], &[TAG_POINTER, 2, 0, 1, 0, 1, 0, 0, 0]);
        assert_eq!(&msg[9..], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }
}
