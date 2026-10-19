//! IPC commands exposed to the frontend. Each submodule mirrors typed wrappers in
//! `ui/src/lib/ipc.ts`.

pub mod app;
pub mod audit;
pub mod devices;
pub mod forwards;
pub mod inventory;
pub mod map;
pub mod serial;
pub mod session;
pub mod settings;
pub mod ssh;
pub mod telnet;
pub mod terminal;
pub mod tftp;
pub mod tools;
pub mod vault;
