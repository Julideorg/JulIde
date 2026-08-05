use std::sync::{Mutex, MutexGuard};

/// Lock a `Mutex`, recovering from poisoning instead of panicking.
///
/// julIDE keeps several long-lived registries behind module-level mutexes
/// (`PTY_SESSIONS`, `CONTAINER_STATE`, `BREAKPOINTS`, `DEBUG_SESSION`). Some are held
/// across blocking reads on a child process's stdout. With plain `.lock().unwrap()`,
/// a single panic anywhere under one of those locks poisons the mutex permanently,
/// so *every* later terminal / container / debugger call panics too — one transient
/// fault bricks the subsystem for the rest of the session.
///
/// Poison recovery is the right trade here: the guarded data is a session registry,
/// not an invariant-carrying structure, so continuing with whatever state it holds is
/// strictly better than a cascading failure the user can only escape by restarting.
pub trait LockRecover<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockRecover<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn recovers_after_a_panic_poisons_the_lock() {
        let m = Arc::new(Mutex::new(vec![1, 2, 3]));

        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();

        assert!(m.lock().is_err(), "expected the mutex to be poisoned");

        // The plain `.lock().unwrap()` above would panic here; lock_recover does not.
        let guard = m.lock_recover();
        assert_eq!(*guard, vec![1, 2, 3]);
    }

    #[test]
    fn behaves_like_lock_when_healthy() {
        let m = Mutex::new(0u32);
        *m.lock_recover() += 5;
        assert_eq!(*m.lock_recover(), 5);
    }
}
