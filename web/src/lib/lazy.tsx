import { lazy, Suspense, type ComponentType } from 'react';

const RELOADED = 'cleftbot.chunk-reload';

/**
 * A part of the app that is loaded when it is first opened (settings, the screen viewer, the file pane),
 * so the first page is smaller and quicker.
 *
 * If the part cannot be loaded because the server was updated since this page opened (its file names are
 * gone), the page reloads once to get the current version, instead of showing an error.
 */
export function lazily<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Part = lazy(async () => {
    try {
      const C = await load();
      try { sessionStorage.removeItem(RELOADED); } catch { /* no storage */ }
      return { default: C };
    } catch (e) {
      let again = false;
      try { again = sessionStorage.getItem(RELOADED) === '1'; if (!again) sessionStorage.setItem(RELOADED, '1'); } catch { again = true; }
      if (!again && navigator.onLine !== false) { window.location.reload(); return { default: (() => null) as unknown as ComponentType<P> }; }
      throw e;
    }
  });
  const Any = Part as unknown as ComponentType<object>;
  return (props: P) => <Suspense fallback={null}><Any {...props} /></Suspense>;
}
