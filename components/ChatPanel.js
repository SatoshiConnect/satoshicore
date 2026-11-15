'use client';

// Encrypted chat screen.
//
// The wallet keeps the plaintext: it is encrypted to the recipient here, with a
// key the relay never has, and decrypted here with this wallet's seed. The relay
// only sees two addresses, a size and a timestamp (docs/E2E-CHAT-DESIGN.md).
//
// The thread lives in this session only. Messages are deleted from the relay as
// soon as they are read, and nothing is written to localStorage — losing the tab
// loses the transcript, which is the price of not keeping plaintext chats at
// rest on a shared device.
import { useCallback, useEffect, useRef, useState } from 'react';

import { createChatClient } from '../lib/chatClient';
import { MAX_TEXT_LENGTH } from '../lib/e2eChat';

const shortAddr = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');

export default function ChatPanel({ seed32, address, contacts, relayOrigin, onBack }) {
  const client = useRef(null);
  const [peer, setPeer] = useState('');
  const [thread, setThread] = useState([]);          // { id, from, text, ts|at, own }
  const [draft, setDraft] = useState('');
  const [state, setState] = useState({ busy: false, note: '', published: false });
  const [inboxState, setInboxState] = useState({ phase: 'idle', error: '' });

  const relayConfigured = Boolean(relayOrigin);
  const readOnly = !seed32;

  useEffect(() => {
    if (!relayConfigured) return undefined;
    client.current = createChatClient({ origin: relayOrigin });
    return () => { client.current = null; };
  }, [relayOrigin, relayConfigured]);

  const publishOwnKey = useCallback(async () => {
    if (!client.current || !seed32 || state.published) return;
    try {
      await client.current.publishKey({ seed32, address });
      setState((current) => ({ ...current, published: true }));
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    }
  }, [address, seed32, state.published]);

  // Publish this wallet's messaging key as soon as the screen opens, so someone
  // else can write to it without having to wait for a first reply.
  useEffect(() => {
    if (!relayConfigured || !seed32) return;
    void publishOwnKey();
  }, [publishOwnKey, relayConfigured, seed32]);

  const openThread = useCallback(async (target) => {
    setPeer(target);
    setThread((current) => current.filter((message) => message.peer === target));
    if (!client.current || !seed32) return;
    setInboxState({ phase: 'loading', error: '' });
    try {
      const { messages, undecryptable } = await client.current.inbox({ seed32, address });
      setThread((current) => {
        const known = new Set(current.map((message) => message.id).filter(Boolean));
        const incoming = messages
          .filter((message) => message.from === target && !known.has(`m${message.id}`))
          .map((message) => ({
            id: `m${message.id}`, peer: message.from, from: message.from,
            text: message.text, at: message.ts, own: false,
          }));
        return [...current, ...incoming].sort((a, b) => (a.at || 0) - (b.at || 0));
      });
      setInboxState({
        phase: undecryptable.length ? 'partial' : 'ready',
        error: undecryptable.length
          ? `${undecryptable.length} message(s) stayed on the relay: this wallet cannot open them.`
          : '',
      });
    } catch (error) {
      setInboxState({ phase: 'unavailable', error: String(error?.message || error) });
    }
  }, [address, seed32]);

  async function send(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !client.current || !seed32 || !peer) return;
    setState((current) => ({ ...current, busy: true, note: '' }));
    try {
      await client.current.send({ seed32, from: address, to: peer, text });
      setThread((current) => [...current, {
        id: `s${Date.now()}`, peer, from: address, text, at: Date.now(), own: true,
      }]);
      setDraft('');
    } catch (error) {
      setState((current) => ({ ...current, note: String(error?.message || error) }));
    } finally {
      setState((current) => ({ ...current, busy: false }));
    }
  }

  if (!relayConfigured) {
    return (
      <div>
        <button type="button" className="nw-chip-btn" onClick={onBack}>← Back</button>
        <section className="nw-card" style={{ marginTop: 12 }}>
          <h2 style={{ color: 'var(--text)', margin: 0 }}>Messages</h2>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            This build has no chat relay configured, so messages cannot be delivered. Nothing is
            uploaded and nothing is queued.
          </p>
        </section>
      </div>
    );
  }

  if (!peer) {
    return (
      <div>
        <button type="button" className="nw-chip-btn" onClick={onBack}>← Back</button>
        <section className="nw-card" style={{ marginTop: 12 }}>
          <h2 style={{ color: 'var(--text)', margin: 0 }}>Messages</h2>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            End-to-end encrypted: the wallet encrypts on this device and the relay only stores
            ciphertext. Choose someone you have transacted with.
          </p>
          {readOnly && (
            <p className="nw-small" style={{ color: 'var(--warn)', margin: '8px 0 0' }}>
              Unlock the wallet to read and send messages.
            </p>
          )}
          {contacts.length === 0 ? (
            <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
              No counterparty yet — a contact appears here once the index shows a transfer with
              this address.
            </p>
          ) : (
            <ul className="nw-tx-list" style={{ marginTop: 8 }}>
              {contacts.map((contact) => (
                <li key={contact} className="nw-tx-row">
                  <div className="nw-tx-dir rec" aria-hidden>✉</div>
                  <div style={{ flex: 1 }}>
                    <div className="nw-notice-title">{shortAddr(contact)}</div>
                    <div className="nw-small nw-dim">encrypted message</div>
                  </div>
                  <button type="button" className="nw-chip-btn"
                    onClick={() => { void publishOwnKey(); void openThread(contact); }}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="nw-chip-btn" onClick={() => { setPeer(''); setThread([]); }}>
          ← Messages
        </button>
        <span className="nw-small nw-dim">{shortAddr(peer)}</span>
      </div>

      <section className="nw-card" style={{ marginTop: 12 }}>
        <h2 style={{ color: 'var(--text)', margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
          {shortAddr(peer)}
          <span className="nw-badge ok">end-to-end encrypted</span>
        </h2>
        <p className="nw-small nw-dim" style={{ margin: '6px 0 0' }}>
          Ciphertext only on the relay. Keys come from this wallet — nobody else can read these.
        </p>

        {inboxState.phase === 'loading' && (
          <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>Checking for messages…</p>
        )}
        {inboxState.error ? (
          <p className="nw-small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>{inboxState.error}</p>
        ) : null}

        <ul className="nw-chat-thread" aria-live="polite" style={{ marginTop: 10 }}>
          {thread.length === 0 && (
            <li className="nw-small nw-dim" style={{ padding: '6px 2px' }}>
              No messages in this session yet.
            </li>
          )}
          {thread.map((message) => (
            <li key={message.id} className={'nw-chat-bubble' + (message.own ? ' is-own' : '')}>
              <div className="nw-chat-text">{message.text}</div>
              <div className="nw-small nw-dim">
                {message.own ? 'sent' : shortAddr(message.from)}
                {message.at ? ` · ${new Date(message.at).toLocaleTimeString()}` : ''}
              </div>
            </li>
          ))}
        </ul>

        <form className="nw-txf" onSubmit={send} style={{ marginTop: 12 }}>
          <textarea className="nw-chat-input" value={draft} maxLength={MAX_TEXT_LENGTH}
            placeholder={readOnly ? 'Unlock the wallet to send' : 'Write an encrypted message…'}
            onChange={(event) => setDraft(event.target.value)} disabled={readOnly || state.busy}
            rows={2} aria-label="Encrypted message" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="nw-send-btn" type="submit"
              disabled={readOnly || state.busy || !draft.trim()}>
              {state.busy ? 'Sending…' : 'Send encrypted'}
            </button>
            <button type="button" className="nw-chip-btn" disabled={state.busy}
              onClick={() => void openThread(peer)}>
              Check inbox
            </button>
          </div>
          {state.note ? (
            <p className="nw-small" style={{ margin: 0, color: 'var(--warn)' }}>{state.note}</p>
          ) : null}
          <p className="nw-small nw-dim" style={{ margin: 0 }}>
            The other wallet receives this only when it opens its own messages; the relay keeps it
            for up to 30 days and deletes it after it is read.
          </p>
        </form>
      </section>
    </div>
  );
}
