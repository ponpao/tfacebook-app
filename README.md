# FB Account Manager

High-performance Windows desktop app for managing and farming thousands of Facebook accounts. Built with Electron + TypeScript + React + Vite + SQLite.

## Stack

| Layer        | Tech                                             |
| ------------ | ------------------------------------------------ |
| Shell        | Electron 34 + `electron-vite`                    |
| Language     | TypeScript (strict)                              |
| UI           | React 19, Tailwind CSS, Lucide icons             |
| Data grid    | TanStack Table + TanStack Virtual (virtualized)  |
| State        | Zustand                                          |
| Database     | SQLite via `better-sqlite3`                      |
| Email (prep) | `imapflow` + `mailparser` (Phase 2 GetCode)      |

## Scripts

```bash
npm install       # installs deps + rebuilds better-sqlite3 for Electron
npm run dev       # launch app with HMR
npm run build     # production build into ./out
npm run typecheck # type-check main + renderer
```

If `better-sqlite3` fails to load at runtime, run `npm run rebuild`.

## Project structure

```
src/
  main/                 Electron main process
    db/                 SQLite connection, schema & repositories
    ipc/                Channel names + ipcMain handlers
    utils/              accountParser.ts (dynamic import parser)
    workers/            imapGetCode.ts (Phase 2 OTP retrieval boilerplate)
    index.ts            main entry
  preload/              contextBridge — safe window.api
  renderer/             React app
    components/         Header, Toolbar, ColumnToggle, table/, modals/
    store/              Zustand store
    styles/             Tailwind entry
  types/                Shared TS types (Account, ImportFormat, Proxy, IPC)
```

## Database (`data.sqlite`)

Stored in Electron's `userData` directory. Tables: `accounts`, `proxies`,
`settings`. Schema is created idempotently on first launch (see
`src/main/db/schema.ts`).

## Dynamic import format

The importer lets you describe any line format using tokens —
`UID`, `PASS`, `2FA`, `EMAIL`, `PASSMAIL`, `MAIL_SERVER`, `DOB`,
`CREATED_DATE`, `LOCATION`, `GENDER`, `COOKIE`, `TOKEN`, `PROXY`, `IGNORE` —
with any separator (`|`, `----`, `:`, `,`, `;`, Tab). Paste a list, pick the
layout, preview the parse, and import. Duplicate UIDs are skipped.

## Phase 2 — Email GetCode

`src/main/workers/imapGetCode.ts` is a typed, working starting point for
automated OTP/confirmation-code retrieval from an account's mailbox. Wire it
into an `ipcMain.handle` when ready; it already infers common IMAP hosts and
extracts numeric codes from recent Facebook mail.
