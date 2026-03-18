# Customizing shell

shell is a web-based terminal with a mobile-friendly command palette. It
SSHs into localhost via a dedicated key, attaches to a tmux session, and
streams it to your browser over WebSocket. Works as a PWA on iOS/Android.

---

## Setup

**1. Generate a dedicated SSH key:**
```sh
ssh-keygen -t ed25519 -f ~/.ssh/shell_key -N ""
cat ~/.ssh/shell_key.pub >> ~/.ssh/authorized_keys
```

**2. Install dependencies:**
```sh
npm install
```

**3. Create a `.env` file:**
```
SHELL_TOKEN=1234
```
Token is used as the PIN on the lock screen. 4 digits recommended.

**4. Run:**
```sh
node server.js
```

---

## Ports

### `SHELL_TOKEN` — auth PIN
**Type:** environment variable
**Required:** yes

The PIN shown on the lock screen. Any string — 4 digits is the default UX,
but longer tokens work (the gate accepts them character by character via the
numpad, or via the URL `?token=` param).

---

### `SSH_KEY` — SSH private key path
**Type:** environment variable
**Default:** `~/.ssh/shell_key`

Path to the private key used to SSH into localhost. The corresponding public
key must be in `~/.ssh/authorized_keys`.

---

### `SSH_USER` — SSH username
**Type:** environment variable
**Default:** current OS username

---

### `TMUX_SESSION` — tmux session name
**Type:** environment variable
**Default:** `main`

The tmux session to attach to (or create). Change this to attach to a
different session, or set up multiple shell instances on different ports
each pointing at different sessions.

---

### `TLS_CERT` / `TLS_KEY` — HTTPS
**Type:** environment variables
**Default:** none (HTTP)

If both are set to file paths of a TLS cert and key, the server runs HTTPS
and WebSocket upgrades use WSS. Strongly recommended when exposing over a
network.

Example with a self-signed cert:
```sh
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
TLS_CERT=cert.pem TLS_KEY=key.pem node server.js
```

---

### `APP_COLOR` — PWA icon color
**Type:** environment variable
**Default:** `#c9a84c` (gold)

Hex color for the generated PWA home screen icon.

---

### `HOST` / `PORT`
**Type:** environment variables
**Defaults:** `127.0.0.1` / `4444`

---

### `palette.json` — command palette buttons
**Type:** JSON file (edit directly)

Array of `{ "label": "...", "cmd": "...", "group": "..." }` objects. Each
becomes a button in the palette sidebar (desktop) / bottom sheet (mobile).
`cmd` is sent directly to the terminal when tapped.

Groups are displayed as labeled sections. Any group name works — add CSS
custom properties to `public/index.html` to color-code them:
```css
.cmd-btn[data-group="mygroup"] { --group-color: #ff6b6b; }
```

---

### `public/index.html` — terminal UI
**Type:** static file (edit directly)

The entire frontend. Served as-is. Customize the color scheme, font size,
layout, or add new UI elements here.
