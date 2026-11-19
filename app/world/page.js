'use client';

// Pixel World — a playable city room.
//
// One account, one session: the page signs in with the same Firebase account the
// wallet uses, reads that account's own characters, and joins a Colyseus city
// room with a single-use ticket minted server-side from the same ID token. There
// is no second login and no game account.
//
// What the renderer draws is the shared city map (`lib/worldMap.js`) — the same
// tiles the server collides against — plus one sprite per character in the room.
// Movement is predicted locally and sent to the server, which clamps it, rejects
// teleports and rejects a step into a building or the water.
//
// Deliberately not here yet: wallet binding in the character creator, in-world
// "send NSAT", chat bubbles and travel between countries. The roster and the
// character card only show what the world actually knows (name, character id,
// position) so nothing on this page claims a verified payment address it has not
// resolved.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadAuthClient } from '../../lib/firebaseAuth';
import { createMyCharacter, listMyCharacters } from '../../lib/charactersClient';
import { joinCity, worldBaseUrl } from '../../lib/worldClient';
import {
  T_BRIDGE, T_BUILDING, T_FOUNTAIN, T_GRASS, T_PATH, T_PLAZA, T_ROAD, T_SAND, T_TREE, T_WATER,
  TILE,
  mapForCity,
  moveWithCollision,
  tileAt,
  tileVariation,
} from '../../lib/worldMap';
import { APPEARANCE_SLOTS, defaultAppearance } from '../../lib/characters';
import './world.css';

const CITIES = Object.freeze([
  { id: 'bangkok', name: 'Bangkok', width: 1280, height: 960 },
  { id: 'chiang-mai', name: 'Chiang Mai', width: 1024, height: 768 },
  { id: 'phuket', name: 'Phuket', width: 1024, height: 768 },
  { id: 'singapore', name: 'Singapore', width: 1152, height: 864 },
]);

// Comfortably inside the server's 150 px/s budget, so ordinary latency never
// looks like a speed hack.
const WALK_SPEED = 118;
const SEND_INTERVAL_MS = 70;

const SKIN = ['#f4d6b8', '#e6b992', '#d09a6e', '#b0764c', '#8a5a34', '#60381f'];
const HAIR = ['#17171b', '#3a2a1e', '#6b4226', '#a86b32', '#d9b56b', '#ece4d6', '#7a2f3a', '#2f4a7a', '#3f7a4a', '#a34ac0'];
const OUTFIT = ['#2f6feb', '#0f766e', '#b91c1c', '#a16207', '#6d28d9', '#0e7490', '#c2410c', '#15803d', '#be185d', '#334155', '#7c3aed', '#ca8a04'];
const ROOFS = ['#b4533f', '#3f6fb4', '#6b4fa0', '#2f7d6b', '#a16207'];

/** The appearance object a room player carries, from the schema fields. */
function appearanceOf(player) {
  return {
    v: 1,
    skin: Number(player.skin) || 0,
    hair: Number(player.hair) || 0,
    outfit: Number(player.outfit) || 0,
    accessory: Number(player.accessory) || 0,
  };
}

const cityById = (id) => CITIES.find((city) => city.id === id) || CITIES[0];

function describeError(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  switch (code) {
    case 'world-offline':
      return 'The world server is not running. Start it with “cd services/world-server && npm start”.';
    case 'join-rejected':
      return 'The city room rejected the join. Sign in again and retry.';
    case 'rate-limited':
      return 'That was too fast. Wait a moment, then try again.';
    case 'character-limit':
      return error.message;
    default:
      return (error && error.message) || 'Something went wrong.';
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function hash(value) {
  let h = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function drawTile(context, map, kind, c, r, px, py, size, time) {
  const variation = tileVariation(map, c, r);
  switch (kind) {
    case T_WATER: {
      context.fillStyle = '#2f6fa8';
      context.fillRect(px, py, size, size);
      context.fillStyle = '#3f86c4';
      const wave = ((time / 900 + variation) % 1) * size;
      context.fillRect(px, py + size * 0.35 + wave * 0.2, size, 2);
      context.fillRect(px + size * 0.2, py + size * 0.7 - wave * 0.15, size * 0.5, 2);
      break;
    }
    case T_SAND:
      context.fillStyle = '#e3d29b';
      context.fillRect(px, py, size, size);
      if (variation > 0.7) {
        context.fillStyle = '#cbb87e';
        context.fillRect(px + size * 0.2, py + size * 0.6, 3, 3);
      }
      break;
    case T_ROAD:
      context.fillStyle = '#59616f';
      context.fillRect(px, py, size, size);
      context.fillStyle = '#4b525f';
      context.fillRect(px, py + size - 4, size, 4);
      if (variation > 0.55) {
        context.fillStyle = '#6a7382';
        context.fillRect(px + size * 0.15, py + size * 0.3, size * 0.7, 2);
      }
      break;
    case T_BRIDGE:
      context.fillStyle = '#8a5a34';
      context.fillRect(px, py, size, size);
      context.fillStyle = '#a06b3f';
      for (let i = 0; i < 4; i += 1) context.fillRect(px, py + i * (size / 4) + 1, size, 2);
      break;
    case T_PATH:
      context.fillStyle = '#c2a874';
      context.fillRect(px, py, size, size);
      context.fillStyle = '#b39a68';
      if (variation > 0.5) context.fillRect(px + size * 0.2, py + size * 0.3, 4, 4);
      break;
    case T_PLAZA:
      context.fillStyle = '#cfc4b0';
      context.fillRect(px, py, size, size);
      context.strokeStyle = '#b9ad97';
      context.lineWidth = 1;
      context.strokeRect(px + 0.5, py + 0.5, size - 1, size - 1);
      break;
    case T_FOUNTAIN:
      context.fillStyle = '#cfc4b0';
      context.fillRect(px, py, size, size);
      context.fillStyle = '#2f6fa8';
      context.beginPath();
      context.arc(px + size / 2, py + size / 2, size * 0.32, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#9fd0f5';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(px + size / 2, py + size / 2, size * 0.18, 0, Math.PI * 2);
      context.stroke();
      break;
    case T_TREE: {
      context.fillStyle = '#4f8f4a';
      context.fillRect(px, py, size, size);
      context.fillStyle = '#6b4a2a';
      context.fillRect(px + size * 0.45, py + size * 0.55, size * 0.12, size * 0.35);
      const canopy = variation > 0.5 ? '#2f7d3f' : '#3a8f4a';
      context.fillStyle = canopy;
      context.beginPath();
      context.arc(px + size / 2, py + size * 0.42, size * 0.34, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#4aa35a';
      context.beginPath();
      context.arc(px + size * 0.42, py + size * 0.36, size * 0.16, 0, Math.PI * 2);
      context.fill();
      break;
    }
    case T_BUILDING: {
      const roof = ROOFS[hash(`${map.city}:${Math.floor(c / 6)}:${Math.floor(r / 6)}`) % ROOFS.length];
      const isTop = tileAt(map, c, r - 1) !== T_BUILDING;
      context.fillStyle = '#d8cbb2';
      context.fillRect(px, py, size, size);
      if (isTop) {
        context.fillStyle = roof;
        context.fillRect(px, py, size, size * 0.72);
        context.fillStyle = 'rgba(0,0,0,0.18)';
        context.fillRect(px, py + size * 0.72 - 3, size, 3);
      } else {
        context.fillStyle = 'rgba(0,0,0,0.10)';
        context.fillRect(px, py, size, 2);
        context.fillStyle = variation > 0.5 ? '#9ec3e0' : '#7fa8c9';
        context.fillRect(px + size * 0.18, py + size * 0.25, size * 0.22, size * 0.24);
        context.fillRect(px + size * 0.6, py + size * 0.25, size * 0.22, size * 0.24);
      }
      break;
    }
    default: {
      // Grass, with a little deterministic texture.
      context.fillStyle = variation > 0.5 ? '#4f8f4a' : '#4a8945';
      context.fillRect(px, py, size, size);
      if (variation > 0.86) {
        context.fillStyle = '#5da155';
        context.fillRect(px + size * 0.3, py + size * 0.4, 3, 3);
      }
    }
  }
}

function drawAvatar(context, {
  x, y, facing, appearance, anim, name, isSelf, scale,
}) {
  const body = appearance || defaultAppearance();
  const skin = SKIN[body.skin % SKIN.length];
  const hairColor = HAIR[body.hair % HAIR.length];
  const outfit = OUTFIT[body.outfit % OUTFIT.length];
  const step = Math.sin(anim) * (anim ? 2 : 0);
  const px = Math.round(x);
  const py = Math.round(y);

  context.save();
  context.translate(px, py);
  context.scale(scale, scale);

  // Shadow.
  context.fillStyle = 'rgba(0,0,0,0.28)';
  context.beginPath();
  context.ellipse(0, 1, 9, 4, 0, 0, Math.PI * 2);
  context.fill();

  if (isSelf) {
    context.strokeStyle = 'rgba(94,234,212,0.9)';
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(0, 1, 12, 5.5, 0, 0, Math.PI * 2);
    context.stroke();
  }

  // Legs.
  context.fillStyle = '#2b3442';
  context.fillRect(-6, -8 + step, 4, 8);
  context.fillRect(2, -8 - step, 4, 8);
  // Shoes.
  context.fillStyle = '#171c26';
  context.fillRect(-7, -1 + step, 6, 2);
  context.fillRect(1, -1 - step, 6, 2);

  // Torso.
  context.fillStyle = outfit;
  context.fillRect(-8, -22, 16, 14);
  context.fillStyle = 'rgba(255,255,255,0.16)';
  context.fillRect(-8, -22, 16, 3);
  // Arms.
  context.fillStyle = skin;
  context.fillRect(-10, -21, 2.5, 10);
  context.fillRect(7.5, -21, 2.5, 10);
  // Backpack.
  if (body.accessory === 6) {
    context.fillStyle = '#4b5563';
    context.fillRect(facing === 'up' ? -7 : 6, -20, 6, 9);
  }

  // Head.
  context.fillStyle = skin;
  context.fillRect(-6, -34, 12, 12);
  // Hair on top and the back of the head, longer when facing up.
  context.fillStyle = hairColor;
  context.fillRect(-6.5, -35, 13, 4.5);
  context.fillRect(-6.5, -31, 2, facing === 'up' ? 10 : 5);
  context.fillRect(4.5, -31, 2, facing === 'up' ? 10 : 5);
  if (body.hair % 3 === 1) context.fillRect(-2, -36.5, 5, 2);
  if (body.hair % 3 === 2) context.fillRect(-6.5, -31, 13, 2);

  // Face.
  if (facing !== 'up') {
    context.fillStyle = '#1c232e';
    const eyeShift = facing === 'left' ? -1.5 : facing === 'right' ? 1.5 : 0;
    context.fillRect(-3 + eyeShift, -29, 1.8, 2);
    context.fillRect(1.4 + eyeShift, -29, 1.8, 2);
  }

  // Accessory.
  if (body.accessory === 1 || body.accessory === 4) {
    context.fillStyle = body.accessory === 1 ? '#eab308' : '#2563eb';
    context.fillRect(-7, -36, 14, 3);
    context.fillRect(-5, -38, 10, 2);
  }
  if (body.accessory === 2) {
    context.fillStyle = '#0f172a';
    context.fillRect(-7, -30, 14, 2);
  }
  if (body.accessory === 3) {
    context.fillStyle = '#dc2626';
    context.fillRect(-8, -23, 16, 3);
  }
  if (body.accessory === 5) {
    context.fillStyle = '#7c3aed';
    context.fillRect(-9, -33, 3, 6);
    context.fillRect(6, -33, 3, 6);
    context.fillRect(-9, -35, 18, 2);
  }
  if (body.accessory === 7) {
    context.fillStyle = '#db2777';
    context.fillRect(-7, -36, 3, 3);
  }

  // Nameplate.
  const text = String(name || '—');
  context.font = '600 9px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const width = context.measureText(text).width + 8;
  context.fillStyle = isSelf ? 'rgba(15,118,110,0.92)' : 'rgba(17,24,39,0.82)';
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(-width / 2, -52, width, 13, 4);
  } else {
    context.rect(-width / 2, -52, width, 13);
  }
  context.fill();
  context.fillStyle = '#f8fafc';
  context.fillText(text, 0, -45.4);

  context.restore();
}

function drawScene(context, {
  width, height, dpr = 1, map, players, self, selfSession, time,
}) {
  const zoom = Math.max(1, Math.min(2, width / 620));
  const viewW = width / zoom;
  const viewH = height / zoom;
  const focus = self || { x: map.width / 2, y: map.height / 2 };
  const camX = Math.max(0, Math.min(map.width - viewW, focus.x - viewW / 2));
  const camY = Math.max(0, Math.min(map.height - viewH, focus.y - viewH / 2));

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#0b1020';
  context.fillRect(0, 0, width * dpr, height * dpr);
  const scale = zoom * dpr;
  context.setTransform(scale, 0, 0, scale, -camX * scale, -camY * scale);

  const size = TILE;
  const c0 = Math.max(0, Math.floor(camX / size));
  const r0 = Math.max(0, Math.floor(camY / size));
  const c1 = Math.min(map.cols - 1, Math.ceil((camX + viewW) / size));
  const r1 = Math.min(map.rows - 1, Math.ceil((camY + viewH) / size));

  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const kind = tileAt(map, c, r);
      drawTile(context, map, kind, c, r, c * size, r * size, size, time);
    }
  }

  // Players, back to front so a character standing lower on screen overlaps the
  // one behind it.
  const ordered = players
    .filter((player) => player.sessionId !== selfSession)
    .slice()
    .sort((a, b) => a.y - b.y);
  for (const player of ordered) {
    drawAvatar(context, {
      x: player.x, y: player.y, facing: player.facing,
      appearance: player.appearance, anim: time / 90 + player.x,
      name: player.name, isSelf: false, scale: 1.5,
    });
  }
  if (self) {
    drawAvatar(context, {
      x: self.x, y: self.y, facing: self.facing,
      appearance: self.appearance, anim: self.anim,
      name: self.name, isSelf: true, scale: 1.5,
    });
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorldPage() {
  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const accountRef = useRef(null);
  const roomRef = useRef(null);
  const clientRef = useRef(null);
  const mapRef = useRef(null);
  const rosterRef = useRef([]);
  const selfRef = useRef(null);
  const selfSessionRef = useRef('');
  const keysRef = useRef({ up: false, down: false, left: false, right: false });
  const lastSentRef = useRef(0);

  const [account, setAccount] = useState(undefined);
  const [authError, setAuthError] = useState('');
  const [characters, setCharacters] = useState(null);
  const [charactersError, setCharactersError] = useState('');
  const [activeCharacterId, setActiveCharacterId] = useState('');
  const [selectedCity, setSelectedCity] = useState(CITIES[0].id);
  const [status, setStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [roster, setRoster] = useState([]);
  const [draftName, setDraftName] = useState('');
  const [draftAppearance, setDraftAppearance] = useState(defaultAppearance);

  const activeCharacter = useMemo(
    () => (characters || []).find((entry) => entry.characterId === activeCharacterId) || null,
    [characters, activeCharacterId],
  );

  const city = useMemo(() => cityById(selectedCity), [selectedCity]);
  const map = useMemo(() => mapForCity(city), [city]);

  useEffect(() => { mapRef.current = map; }, [map]);
  useEffect(() => { rosterRef.current = roster; }, [roster]);
  useEffect(() => { accountRef.current = account; }, [account]);

  // ---- session -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;
    loadAuthClient()
      .then(({ auth, authSdk }) => {
        if (cancelled) return;
        accountRef.current = auth;
        unsubscribe = authSdk.onAuthStateChanged(auth, (user) => {
          setAccount(user ? { uid: user.uid, email: user.email || '' } : null);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setAuthError('Sign-in is not configured for this build.');
          setAccount(null);
        }
      });
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!account?.uid) {
      setCharacters(null);
      return undefined;
    }
    let cancelled = false;
    setCharacters(null);
    setCharactersError('');
    listMyCharacters(account.uid)
      .then((list) => {
        if (cancelled) return;
        setCharacters(list);
        setActiveCharacterId((current) => (
          list.some((entry) => entry.characterId === current)
            ? current
            : (list[0] ? list[0].characterId : '')
        ));
      })
      .catch((error) => {
        if (!cancelled) {
          setCharacters([]);
          setCharactersError(error?.message || 'Your characters could not be loaded.');
        }
      });
    return () => { cancelled = true; };
  }, [account]);

  // ---- room lifecycle ------------------------------------------------------
  const leaveRoom = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    try { room?.leave(true); } catch { /* already gone */ }
    try { clientRef.current?.close?.(); } catch { /* already gone */ }
    clientRef.current = null;
    selfRef.current = null;
    selfSessionRef.current = '';
    setRoster([]);
    rosterRef.current = [];
  }, []);

  useEffect(() => leaveRoom, [leaveRoom]);

  const enterCity = useCallback(async (cityId) => {
    const auth = accountRef.current;
    if (!auth?.currentUser || !activeCharacter) return;
    leaveRoom();
    setSelectedCity(cityId);
    setStatus('joining');
    setStatusMessage('');
    try {
      const idToken = await auth.currentUser.getIdToken();
      const { room, client } = await joinCity({
        idToken,
        characterId: activeCharacter.characterId,
        city: cityId,
        base: worldBaseUrl(),
        ClientClass: null,
      });
      roomRef.current = room;
      clientRef.current = client;
      selfSessionRef.current = room.sessionId;
      room.onStateChange((state) => {
        const list = [];
        state.players?.forEach((player, sessionId) => {
          list.push({
            sessionId,
            characterId: player.characterId,
            name: player.name,
            x: player.x,
            y: player.y,
            facing: player.facing,
            appearance: appearanceOf(player),
          });
        });
        setRoster(list);
        rosterRef.current = list;
        const own = list.find((entry) => entry.sessionId === room.sessionId);
        if (own) {
          if (!selfRef.current) {
            selfRef.current = {
              x: own.x, y: own.y, facing: own.facing, anim: 0,
              name: activeCharacter.name,
              appearance: activeCharacter.appearance,
            };
          } else if (Math.hypot(own.x - selfRef.current.x, own.y - selfRef.current.y) > 96) {
            // The server corrected a position we predicted wrong (a rejected
            // step, a speed clamp). Trust it.
            selfRef.current.x = own.x;
            selfRef.current.y = own.y;
            selfRef.current.facing = own.facing;
          }
        }
      });
      room.onLeave((code) => {
        if (roomRef.current !== room) return;
        roomRef.current = null;
        setStatus('idle');
        setStatusMessage(code === 4001
          ? 'This character was opened in another window, so this session left the city.'
          : 'You left the city.');
      });
      setStatus('playing');
    } catch (error) {
      setStatus('error');
      setStatusMessage(describeError(error));
      leaveRoom();
    }
  }, [activeCharacter, leaveRoom]);

  // ---- input ---------------------------------------------------------------
  useEffect(() => {
    if (status !== 'playing') return undefined;
    const setKey = (event, pressed) => {
      const key = event.key;
      const mapKey = key === 'ArrowUp' || key === 'w' || key === 'W' ? 'up'
        : key === 'ArrowDown' || key === 's' || key === 'S' ? 'down'
          : key === 'ArrowLeft' || key === 'a' || key === 'A' ? 'left'
            : key === 'ArrowRight' || key === 'd' || key === 'D' ? 'right'
              : '';
      if (!mapKey) return;
      event.preventDefault();
      keysRef.current[mapKey] = pressed;
    };
    const down = (event) => setKey(event, true);
    const up = (event) => setKey(event, false);
    const blur = () => { keysRef.current = { up: false, down: false, left: false, right: false }; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      blur();
    };
  }, [status]);

  // ---- game loop -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    let frame = null;
    let last = performance.now();

    const step = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const currentMap = mapRef.current;
      const self = selfRef.current;

      if (status === 'playing' && self && currentMap) {
        const keys = keysRef.current;
        const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
        if (dx || dy) {
          const length = Math.hypot(dx, dy) || 1;
          const next = moveWithCollision(
            currentMap, self.x, self.y,
            (dx / length) * WALK_SPEED * dt,
            (dy / length) * WALK_SPEED * dt,
          );
          self.x = next.x;
          self.y = next.y;
          self.facing = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'down' : 'up');
          self.anim += dt * 9;
          if (now - lastSentRef.current > SEND_INTERVAL_MS) {
            lastSentRef.current = now;
            roomRef.current?.send('move', {
              x: Math.round(self.x), y: Math.round(self.y), facing: self.facing,
            });
          }
        } else {
          self.anim = 0;
        }
      }

      const dpr = Number(canvas.dataset.dpr) || 1;
      drawScene(context, {
        width: canvas.width / dpr,
        height: canvas.height / dpr,
        dpr,
        map: currentMap,
        players: rosterRef.current,
        self: status === 'playing' ? self : null,
        selfSession: selfSessionRef.current,
        time: now,
      });
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [status]);

  // Size the canvas to its container, in device pixels.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth || 900;
      const cssHeight = Math.max(320, Math.min(560, Math.round(cssWidth * 0.58)));
      canvas.style.height = `${cssHeight}px`;
      canvas.dataset.dpr = String(dpr);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Appearance preview while creating a character.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 120;
    const height = 150;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, width, height);
    drawAvatar(context, {
      x: width / 2, y: height - 34, facing: 'down',
      appearance: draftAppearance, anim: 0, name: draftName || 'New', isSelf: false, scale: 2,
    });
  }, [draftAppearance, draftName]);

  // ---- actions -------------------------------------------------------------
  const signIn = useCallback(async () => {
    setStatusMessage('');
    try {
      const { auth, authSdk } = await loadAuthClient();
      const provider = new authSdk.GoogleAuthProvider();
      await authSdk.signInWithPopup(auth, provider);
    } catch (error) {
      setAuthError(error?.message || 'Sign-in did not complete.');
    }
  }, []);

  const createCharacter = useCallback(async () => {
    if (!account?.uid) return;
    setCharactersError('');
    try {
      const created = await createMyCharacter({
        uid: account.uid, name: draftName, appearance: draftAppearance,
      });
      const list = await listMyCharacters(account.uid);
      setCharacters(list);
      setActiveCharacterId(created ? created.characterId : '');
      setDraftName('');
    } catch (error) {
      setCharactersError(describeError(error));
    }
  }, [account, draftName, draftAppearance]);

  const setAppearanceField = (slot, value) => {
    setDraftAppearance((current) => ({ ...current, [slot]: Number(value) }));
  };

  const togglePad = (direction, pressed) => {
    keysRef.current[direction] = pressed;
  };

  const badge = status === 'playing'
    ? { text: `${roster.length} online`, tone: 'ok' }
    : status === 'joining'
      ? { text: 'joining…', tone: 'wait' }
      : status === 'error'
        ? { text: 'not in the city', tone: 'bad' }
        : { text: 'world stopped', tone: 'wait' };

  const gate = (() => {
    if (account === undefined) return <p className="world-gate-text">Checking your session…</p>;
    if (account === null) {
      return (
        <div className="world-gate">
          <h2>Sign in to walk the city</h2>
          <p>The world uses the SatoshiCore account you already have — one login, not two.</p>
          {authError ? <p className="world-gate-error">{authError}</p> : null}
          <button type="button" className="world-primary" onClick={signIn}>Sign in with Google</button>
        </div>
      );
    }
    if (status === 'joining') {
      return <p className="world-gate-text">Entering {city.name}…</p>;
    }
    if (characters === null) return <p className="world-gate-text">Loading your characters…</p>;
    if (charactersError) {
      return (
        <div className="world-gate">
          <h2>Your characters could not be loaded</h2>
          <p className="world-gate-error">{charactersError}</p>
          <p className="world-gate-hint">
            If this is a fresh deployment, the character rules may not be published yet.
          </p>
        </div>
      );
    }
    if (!characters.length) {
      return (
        <div className="world-gate world-gate-create">
          <h2>Create your first character</h2>
          <p>One character is one identity in the world. A wallet can be linked later, from the wallet screen.</p>
          <div className="world-create">
            <label>
              Name
              <input
                value={draftName}
                maxLength={24}
                placeholder="Nok"
                onChange={(event) => setDraftName(event.target.value)}
              />
            </label>
            <div className="world-create-slots">
              {Object.entries(APPEARANCE_SLOTS).map(([slot, size]) => (
                <label key={slot}>
                  {slot}
                  <select value={draftAppearance[slot]} onChange={(event) => setAppearanceField(slot, event.target.value)}>
                    {Array.from({ length: size }, (_, index) => (
                      <option key={index} value={index}>{index + 1}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <canvas ref={previewRef} className="world-preview" aria-label="Character preview" />
            <button type="button" className="world-primary" onClick={createCharacter}>
              Create character
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="world-gate">
        <h2>Walk into {city.name}</h2>
        <p>Choose a character, then enter. Movement is server-checked; the city is shared.</p>
        <div className="world-characters">
          {characters.map((entry) => (
            <button
              key={entry.characterId}
              type="button"
              className={entry.characterId === activeCharacterId ? 'is-active' : ''}
              onClick={() => setActiveCharacterId(entry.characterId)}
            >
              <strong>{entry.name}</strong>
              <span>{entry.hasWallet ? 'wallet linked' : 'no wallet yet'}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="world-primary"
          disabled={!activeCharacter}
          onClick={() => enterCity(selectedCity)}
        >
          Enter {city.name}
        </button>
      </div>
    );
  })();

  return (
    <main className="world">
      <header className="world-head">
        <div>
          <p className="world-kicker">NSAT · PIXEL WORLD</p>
          <h1>{city.name}</h1>
          <p className="world-sub">
            A shared pixel city. The map, buildings and streets are fictional game scenes
            placed from the city&apos;s real name and shape — not real-world coordinates.
          </p>
        </div>
        <span className={`world-badge world-badge-${badge.tone}`}>{badge.text}</span>
      </header>

      <nav className="world-cities" aria-label="City">
        {CITIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === selectedCity ? 'is-active' : ''}
            disabled={status === 'joining'}
            onClick={() => {
              if (status === 'playing') enterCity(entry.id);
              else setSelectedCity(entry.id);
            }}
          >
            {entry.name}
          </button>
        ))}
      </nav>

      <section className="world-stage" aria-label={`${city.name} map`}>
        <canvas ref={canvasRef} className="world-canvas" />
        {status !== 'playing' ? gate : null}
        {status === 'playing' ? (
          <>
            <div className="world-hud">
              <span>WASD / arrows to walk</span>
              <button type="button" onClick={() => { leaveRoom(); setStatus('idle'); setStatusMessage('You left the city.'); }}>
                Leave
              </button>
            </div>
            <div className="world-pad" aria-label="Move">
              <button type="button" aria-label="Up" onPointerDown={() => togglePad('up', true)} onPointerUp={() => togglePad('up', false)} onPointerLeave={() => togglePad('up', false)}>▲</button>
              <button type="button" aria-label="Left" onPointerDown={() => togglePad('left', true)} onPointerUp={() => togglePad('left', false)} onPointerLeave={() => togglePad('left', false)}>◀</button>
              <button type="button" aria-label="Down" onPointerDown={() => togglePad('down', true)} onPointerUp={() => togglePad('down', false)} onPointerLeave={() => togglePad('down', false)}>▼</button>
              <button type="button" aria-label="Right" onPointerDown={() => togglePad('right', true)} onPointerUp={() => togglePad('right', false)} onPointerLeave={() => togglePad('right', false)}>▶</button>
            </div>
          </>
        ) : null}
      </section>

      {statusMessage ? <p className="world-message">{statusMessage}</p> : null}

      <ul className="world-roster">
        {roster.length ? roster.map((player) => (
          <li key={player.sessionId}>
            <span className="world-dot" style={{ background: OUTFIT[(player.appearance?.outfit ?? 0) % OUTFIT.length] }} />
            <strong>{player.name}{player.sessionId === selfSessionRef.current ? ' (you)' : ''}</strong>
            <span>{player.characterId.slice(0, 10)}… · x {Math.round(player.x)} · y {Math.round(player.y)}</span>
          </li>
        )) : (
          <li className="world-roster-empty">
            {status === 'playing'
              ? 'You are the only character here right now. Open another browser profile to meet yourself.'
              : 'Nobody is in the city yet.'}
          </li>
        )}
      </ul>

      <p className="world-note">
        Next slice: verified wallet binding in the character creator, and “send NSAT” from a
        character card once that binding is verified by the world server.
      </p>
    </main>
  );
}
