// GIVE THE TESTS BACK A WORKING `localStorage`.
//
// Node 26 added its own `localStorage` global, and it is inert unless the process was started
// with `--localstorage-file`: the property is defined, the getter returns `undefined`, and you
// get an ExperimentalWarning on stderr. That definition lands on `globalThis` and SHADOWS the
// one jsdom installs, so from Node 26 onward every `localStorage.clear()` in this suite threw
// `Cannot read properties of undefined (reading 'clear')` — 33 failures across five files
// (terminal-options, ghost-probe, rail-foot, forgotten-projects, lane-accents), none of them a
// defect in the code they cover. They were carried as "pre-existing" through several releases.
//
// The fix has to hand back an instance of JSDOM'S OWN `Storage` class, not a hand-rolled
// object: the tests that cover the storage-is-unavailable path do it with
// `vi.spyOn(Storage.prototype, 'getItem')`, which only reaches an instance whose prototype is
// that ambient class. jsdom's constructor is not callable from userland ("Illegal
// constructor"), and a `Storage` borrowed from a second JSDOM realm would be a different class
// with a different prototype — so the spy would attach to one object and the code would call
// another, and the test would fail while reporting nothing useful.
//
// `sessionStorage` is the one working instance of that exact class already in the environment,
// and nothing in `src/` reads or writes it — grep it and this comment is the only hit. So it is
// the store, under both names.
//
// Guarded, so this is a no-op wherever jsdom's own `localStorage` survives (Node 20/22, and any
// future Node that stops shadowing it).
if (typeof globalThis.localStorage === 'undefined' && typeof globalThis.sessionStorage !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: globalThis.sessionStorage,
    configurable: true,
    writable: true,
  })
}
