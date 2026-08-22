//! Presence detection for GIA Cowork.
//!
//! Linux has no single "is the user active" API the way some other OSes
//! do -- X11 and Wayland expose idle/lock state differently, and every
//! desktop environment (GNOME, KDE, etc.) has its own quirks on top of
//! that. The one thing that *is* standard across virtually all modern
//! Linux desktops is systemd-logind's DBus interface, which every major
//! DE reports session lock state through. We use that rather than trying
//! to homebrew a per-desktop-environment detector.
//!
//! Scope note: this gives real screen lock/unlock state today. Keyboard/
//! mouse idle-time (distinguishing PRESENT from merely "unlocked but not
//! touched in 10 minutes") is a separate, harder problem on Linux -- X11's
//! XScreenSaver extension covers X11 sessions but not Wayland, and there
//! is no portable Wayland equivalent yet. That's deliberately left out of
//! this pass rather than faked with a fixed timeout that would just be
//! guessing.

use serde::Serialize;
use zbus::blocking::Connection;
use zbus::proxy;

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LockState {
    Locked,
    Unlocked,
    /// No systemd-logind session found, or DBus unreachable (e.g. a
    /// minimal/non-systemd distro). Callers should treat this as "don't
    /// know" rather than assuming either state.
    Unknown,
}

#[derive(Clone, Serialize)]
pub struct PresenceInfo {
    pub lock_state: LockState,
}

// org.freedesktop.login1.Session has a `LockedHint` boolean property that
// every major DE (GNOME, KDE, etc.) sets when the session screen is locked.
#[proxy(
    interface = "org.freedesktop.login1.Session",
    default_service = "org.freedesktop.login1"
)]
trait Login1Session {
    #[zbus(property)]
    fn locked_hint(&self) -> zbus::Result<bool>;
}

#[proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login1Manager {
    fn get_session_by_PID(&self, pid: u32) -> zbus::Result<zbus::zvariant::OwnedObjectPath>;
}

fn query_lock_state() -> zbus::Result<bool> {
    let conn = Connection::system()?;
    let manager = Login1ManagerProxyBlocking::new(&conn)?;
    let pid = std::process::id();
    let session_path = manager.get_session_by_PID(pid)?;
    let session = Login1SessionProxyBlocking::builder(&conn)
        .path(session_path)?
        .build()?;
    session.locked_hint()
}

#[tauri::command]
pub fn get_presence() -> PresenceInfo {
    let lock_state = match query_lock_state() {
        Ok(true) => LockState::Locked,
        Ok(false) => LockState::Unlocked,
        Err(e) => {
            // Not fatal -- just means we can't tell. Most likely a non-
            // systemd system, or no active login1 session for this PID
            // (e.g. running inside certain containers/sandboxes).
            eprintln!("[presence] could not query login1 lock state: {e}");
            LockState::Unknown
        }
    };
    PresenceInfo { lock_state }
}
