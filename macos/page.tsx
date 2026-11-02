import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type State = {
  type: 'state';
  host: 'running' | 'stopped';
  pid: number | null;
  badge: number;
  view: 'home' | 'diagnostic';
  permission: string;
};
type Command = { type: 'command'; action: 'badge' | 'notify' | 'restart' };

declare global {
  interface Window {
    webkit: { messageHandlers: { diagnostic: { postMessage: (message: Command) => void } } };
    receiveDiagnostic: (message: unknown) => void;
  }
}

function App() {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    window.receiveDiagnostic = (message: unknown) => {
      if (
        typeof message !== 'object' || message === null ||
        !('type' in message) || message.type !== 'state' ||
        !('host' in message) || !['running', 'stopped'].includes(String(message.host)) ||
        !('pid' in message) || (message.pid !== null && typeof message.pid !== 'number') ||
        !('badge' in message) || typeof message.badge !== 'number' ||
        !('view' in message) || !['home', 'diagnostic'].includes(String(message.view)) ||
        !('permission' in message) || typeof message.permission !== 'string'
      ) return;
      setState(message as State);
    };
    window.webkit.messageHandlers.diagnostic.postMessage({ type: 'command', action: 'restart' });
    return () => { delete (window as Partial<Window>).receiveDiagnostic; };
  }, []);
  const send = (action: Command['action']) => window.webkit.messageHandlers.diagnostic.postMessage({ type: 'command', action });
  return <main>
    <h1>Mischief diagnostic</h1>
    <p>Host: {state?.host ?? 'connecting'} {state?.pid && `(PID ${state.pid})`}</p>
    <p>View: {state?.view ?? '—'} · Badge: {state?.badge ?? '—'}</p>
    <p>Notification permission: {state?.permission ?? 'checking'}</p>
    <button disabled={state?.host !== 'running'} onClick={() => send('badge')}>Toggle badge</button>{' '}
    <button disabled={state?.host !== 'running'} onClick={() => send('notify')}>Notify diagnostic view</button>{' '}
    <button disabled={state?.host !== 'stopped'} onClick={() => send('restart')}>Restart Host</button>
    <p>Close the window and click the Dock icon to reconnect. Quit to stop the Host.</p>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
