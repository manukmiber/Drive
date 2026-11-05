// The scheme before the app draws (ADR-101): dark unless the person chose light on this device
// (the same key as zeiko.biz.id). Loaded in <head>, so a light page never flashes dark first.
try {
  if (localStorage.getItem('zeiko-theme') === 'light') {
    document.documentElement.classList.add('light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff');
  }
} catch {
  // Storage blocked: stay dark.
}
