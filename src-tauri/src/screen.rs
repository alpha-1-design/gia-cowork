//! Real Linux screen capture + input for GIA Cowork.
//!
//! On desktop, "see and control the screen" is a first-class OS capability.
//! We capture via the `screenshots` crate (X11 + Wayland via portals) and
//! inject input via `enigo`. This is what lets GIA do everything Claude's
//! computer-use can -- read the screen, click, type, scroll, drag -- instead
//! of the Android accessibility shim the mobile app used. The mobile app's
//! agent *couldn't* synthesize raw input; the desktop can.

use base64::Engine as _;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Serialize;
use screenshots::image::DynamicImage;
use std::io::Cursor;

#[derive(Serialize)]
pub struct ScreenCapture {
    /// data: URL (base64 PNG) the frontend can hand straight to the model.
    #[serde(rename = "dataUrl")]
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

fn encode_png(img: screenshots::image::RgbaImage) -> Result<String, String> {
    let dyn_img = DynamicImage::ImageRgba8(img);
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        dyn_img
            .write_to(&mut cursor, screenshots::image::ImageOutputFormat::Png)
            .map_err(|e| format!("encode png failed: {e}"))?;
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

fn primary_screen() -> Result<screenshots::Screen, String> {
    let mut screens = screenshots::Screen::all().map_err(|e| format!("no screens: {e}"))?;
    screens
        .into_iter()
        .next()
        .ok_or_else(|| "no display found".to_string())
}

#[tauri::command]
pub fn screen_capture() -> Result<ScreenCapture, String> {
    let screen = primary_screen()?;
    let img = screen.capture().map_err(|e| format!("capture failed: {e}"))?;
    let (width, height) = (img.width(), img.height());
    let data_url = format!("data:image/png;base64,{}", encode_png(img)?);
    Ok(ScreenCapture {
        data_url,
        width,
        height,
    })
}

#[tauri::command]
pub fn screen_capture_area(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<ScreenCapture, String> {
    let screen = primary_screen()?;
    let img = screen
        .capture_area(x, y, width, height)
        .map_err(|e| format!("capture failed: {e}"))?;
    let data_url = format!("data:image/png;base64,{}", encode_png(img)?);
    Ok(ScreenCapture {
        data_url,
        width,
        height,
    })
}

/// Run a closure with a fresh Enigo instance. Enigo opens a display connection
/// per call, which is fine for discrete automation actions.
fn with_enigo<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut Enigo) -> Result<T, String>,
{
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("input init failed (no display / no permission): {e}"))?;
    f(&mut enigo)
}

#[tauri::command]
pub fn screen_tap(x: i32, y: i32) -> Result<(), String> {
    with_enigo(|e| {
        e.move_mouse(x, y, Coordinate::Abs)
            .map_err(|err| err.to_string())?;
        e.button(Button::Left, Direction::Click)
            .map_err(|err| err.to_string())
    })
}

#[tauri::command]
pub fn screen_double_tap(x: i32, y: i32) -> Result<(), String> {
    with_enigo(|e| {
        e.move_mouse(x, y, Coordinate::Abs)
            .map_err(|err| err.to_string())?;
        e.button(Button::Left, Direction::Click)
            .map_err(|err| err.to_string())?;
        e.button(Button::Left, Direction::Click)
            .map_err(|err| err.to_string())
    })
}

#[tauri::command]
pub fn screen_right_tap(x: i32, y: i32) -> Result<(), String> {
    with_enigo(|e| {
        e.move_mouse(x, y, Coordinate::Abs)
            .map_err(|err| err.to_string())?;
        e.button(Button::Right, Direction::Click)
            .map_err(|err| err.to_string())
    })
}

#[tauri::command]
pub fn screen_drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> Result<(), String> {
    with_enigo(|e| {
        e.move_mouse(from_x, from_y, Coordinate::Abs)
            .map_err(|err| err.to_string())?;
        e.button(Button::Left, Direction::Press)
            .map_err(|err| err.to_string())?;
        e.move_mouse(to_x, to_y, Coordinate::Abs)
            .map_err(|err| err.to_string())?;
        e.button(Button::Left, Direction::Release)
            .map_err(|err| err.to_string())
    })
}

#[tauri::command]
pub fn screen_type_text(text: String) -> Result<(), String> {
    with_enigo(|e| e.text(&text).map_err(|err| err.to_string()))
}

#[tauri::command]
pub fn screen_key(key: String) -> Result<(), String> {
    with_enigo(|e| {
        let k = map_key(&key);
        e.key(k, Direction::Click).map_err(|err| err.to_string())
    })
}

#[tauri::command]
pub fn screen_scroll(dx: i32, dy: i32) -> Result<(), String> {
    with_enigo(|e| {
        if dy != 0 {
            e.scroll(dy, enigo::Axis::Vertical)
                .map_err(|err| err.to_string())?;
        }
        if dx != 0 {
            e.scroll(dx, enigo::Axis::Horizontal)
                .map_err(|err| err.to_string())?;
        }
        Ok(())
    })
}

/// Map a human key name (or single character) to an enigo `Key`.
fn map_key(key: &str) -> Key {
    match key.to_lowercase().as_str() {
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "shift" => Key::Shift,
        "control" | "ctrl" => Key::Control,
        "alt" => Key::Alt,
        "meta" | "super" | "cmd" | "win" => Key::Meta,
        other => {
            if let Some(c) = other.chars().next() {
                Key::Unicode(c)
            } else {
                Key::Unicode(' ')
            }
        }
    }
}
