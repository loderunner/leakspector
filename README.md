# leakspector

[![npm version](https://img.shields.io/npm/v/leakspector)](https://www.npmjs.com/package/leakspector)
[![CI status](https://github.com/loderunner/leakspector/actions/workflows/lint-test-build.yml/badge.svg)](https://github.com/loderunner/leakspector/actions)
[![bundle size](https://img.shields.io/bundlephobia/minzip/leakspector)](https://bundlephobia.com/package/leakspector)
[![license](https://img.shields.io/npm/l/leakspector)](LICENSE)
[![Ko-fi donate](https://img.shields.io/badge/Ko--fi-donate-ff5f5f?logo=ko-fi&logoColor=white)](https://ko-fi.com/loderunner)
[![NPM Trusted Publishing](https://img.shields.io/badge/NPM-Trusted%20Publishing-success?logo=npm)](https://www.npmjs.com/package/leakspector#provenance-details-header)

A Node.js library for detecting memory leaks. Track resources in your code and
verify they're cleaned up properly.

- [Overview](#overview)
- [Installation](#installation)
- [Usage](#usage)
  - [Basic Setup with Vitest](#basic-setup-with-vitest)
  - [Example Test](#example-test)
  - [With Garbage Collection](#with-garbage-collection)
  - [Suppress Errors (Debug Mode)](#suppress-errors-debug-mode)
- [What Gets Tracked](#what-gets-tracked)
  - [Event Listeners](#event-listeners)
  - [Timers](#timers)
- [API](#api)
  - [`track(options?)`](#trackoptions)
  - [`check(options?)`](#checkoptions)
- [License](#license)

## Overview

leakspector helps you catch memory leaks in your code by tracking resource usage
and comparing it against the initial state. While commonly used within test
runners to detect leaks in code under test, it can also be used outside of
tests. Currently tracks:

- **Event listeners** on `EventEmitter` instances
- **Timers** `setTimeout` and `setInterval`

## Installation

```bash
npm install --save-dev leakspector
# or
pnpm add --save-dev leakspector
# or
yarn add --dev leakspector
# or
bun add --dev leakspector
```

## Usage

Leakspector is best used in conjunction with a test runner like
[Vitest](https://vitest.dev/) or [Jest](https://jestjs.io/).

### Basic Setup with Vitest

```typescript
import { beforeEach, afterEach } from 'vitest';
import { track, check } from 'leakspector';

beforeEach(() => {
  track();
});

afterEach(async () => {
  await check();
});
```

### Example Test

```typescript
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';

describe('my feature', () => {
  it('should clean up event listeners', () => {
    const emitter = new EventEmitter();
    const handler = () => {};

    emitter.on('data', handler);
    emitter.off('data', handler); // Properly cleaned up
    // Test passes - no leaks detected
  });

  it('should fail if listeners leak', () => {
    const emitter = new EventEmitter();
    const handler = () => {};

    emitter.on('data', handler);
    // Forgot to remove handler - leak detected, test fails in afterEach
  });

  it('should clean up timers', () => {
    const id = setTimeout(() => {}, 1000);
    clearTimeout(id); // Properly cleaned up
    // Test passes - no leaks detected
  });

  it('should fail if timers leak', () => {
    setTimeout(() => {}, 1000);
    // Forgot to clear timer - leak detected, test fails in afterEach
  });
});
```

### Taking Snapshots

Take snapshots of current resource state:

```typescript
import { track, snapshot } from 'leakspector';

track();
// ... create some resources ...

const snap = snapshot();
// snap = {
//   eventListeners: { 'EventEmitter#1': { data: 1 } },
//   timers: { setTimeout: 2, setInterval: 0 }
// }
```

### With Garbage Collection

For more accurate leak detection, force garbage collection before checking:

```typescript
afterEach(async () => {
  await check({ forceGC: true });
});
```

**Note:** To use `forceGC`, run Node.js with the `--expose-gc` flag.

```shell
node --expose-gc your-script.js
# or
NODE_OPTIONS=--expose-gc your-script.js
```

If using Vitest, add this to your config:

```typescript
// vitest.config.ts
export default {
  // ...
  test: {
    // ...
    execArgv: ['--expose-gc'],
  },
};
```

If using Jest, configure your `test` script in `package.json`:

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--expose-gc' jest"
  }
}
```

### Suppress Errors (Debug Mode)

To check for leaks without failing tests:

```typescript
afterEach(async () => {
  await check({ throwOnLeaks: false });
  // Leaks will be logged to console.error instead
});
```

## What Gets Tracked

Leakspector tracks the following resources:

- [Event Listeners](#event-listeners)
- [Timers](#timers)

### Event Listeners

Tracks all EventEmitter instances and their listeners. Detects leaks when
listeners are added but not removed.

```typescript
track();
const emitter = new EventEmitter();
emitter.on('event', handler);
// If handler isn't removed and EventEmitter is not garbage collected before
// check() is called, a leak is detected
```

The library patches EventEmitter methods (`on`, `addListener`, `once`,
`removeListener`, `off`) to monitor listener registration. Original methods are
restored after `check()` is called.

#### Built-in EventEmitter Identification

leakspector automatically identifies common EventEmitter types and provides
meaningful names in error messages and snapshots:

- **net.Socket**: `Socket (127.0.0.1:3000)` or `Socket (not connected)`
- **net.Server**: `Server (127.0.0.1:3000)` or `Server (not listening)`
- **fs.ReadStream**: `ReadStream (/path/to/file)`
- **fs.WriteStream**: `WriteStream (/path/to/file)`
- **child_process.ChildProcess**: `ChildProcess (pid 12345)`
- **cluster.Worker**: `Worker (id 1)`
- **http.IncomingMessage**: `IncomingMessage (GET /api/users)`
- **http.ServerResponse**: `ServerResponse (200 OK)`
- **http.ClientRequest**: `ClientRequest (POST example.com /api/data)`

For unknown types, fallback IDs like `EventEmitter#1`, `EventEmitter#2` are
used.

#### Custom EventEmitter Stringifiers

You can register custom stringifiers to identify your own EventEmitter
subclasses or third-party library types. Custom stringifiers are checked
**before** built-in ones, allowing you to override default behavior.

##### Basic Usage

```typescript
import { registerEmitterStringifier } from 'leakspector';

class MyCustomEmitter extends EventEmitter {
  constructor(public id: string) {
    super();
  }
}

registerEmitterStringifier((emitter) => {
  if (emitter instanceof MyCustomEmitter) {
    return `MyCustomEmitter (id: ${emitter.id})`;
  }
});
```

##### Setup in Vitest

Register stringifiers in a setup file (e.g. `vitest.setup.ts`):

```typescript
// vitest.setup.ts
registerEmitterStringifier((emitter) => {
  if (emitter instanceof MyCustomEmitter) {
    return `MyCustomEmitter (id: ${emitter.id})`;
  }
});

// vitest.config.ts
export default {
  // ... other config ...
  setupFiles: ['vitest.setup.ts'],
};
```

##### Multiple Stringifiers

You can register multiple stringifiers. They're checked in registration order,
and the first one to return a non-null/undefined string wins:

```typescript
registerEmitterStringifier((emitter) => {
  if (emitter instanceof TypeA) {
    return `TypeA (${emitter.name})`;
  }
});

registerEmitterStringifier((emitter) => {
  if (emitter instanceof TypeB) {
    return `TypeB (${emitter.id})`;
  }
});
```

##### Pass-Through Behavior

Return `null`, `undefined`, or omit the return statement to pass through to the
next stringifier:

```typescript
registerEmitterStringifier((emitter) => {
  if (emitter instanceof MyType) {
    return `MyType (${emitter.id})`;
  }
});
```

### Timers

Tracks `setTimeout` and `setInterval` calls. Detects leaks when timers are
created but not cleared.

```typescript
track();
const id = setTimeout(() => {}, 1000);
// If timer isn't cleared before check() is called, a leak is detected
clearTimeout(id); // Properly cleaned up
```

The library patches global `setTimeout`, `setInterval`, `clearTimeout`, and
`clearInterval` functions to monitor timer creation and cleanup. Original
functions are restored after `check()` is called.

## API

### `track(options?)`

Starts tracking resources in your code. When used in tests, call this in
`beforeEach` before executing code that creates resources you want to track.

**Parameters:**

- `options.trackers` (optional): Which trackers to enable. Defaults to `"all"`
  if not provided.
  - `"all"`: Enable all available trackers (event listeners and timers)
  - `TrackerName[]`: Array of specific tracker names to enable (e.g.,
    `["eventListeners"]`, `["timers"]`, or `["eventListeners", "timers"]`)

**Throws:** `Error` if tracking is already active. Call `check()` first to
reset.

**Examples:**

```typescript
// Enable all trackers (default)
track();

// Explicitly enable all trackers
track({ trackers: 'all' });

// Enable only event listeners
track({ trackers: ['eventListeners'] });

// Enable only timers
track({ trackers: ['timers'] });

// Enable multiple specific trackers
track({ trackers: ['eventListeners', 'timers'] });
```

### `check(options?)`

Checks for leaks by comparing current resource usage against the initial state.
When used in tests, call this in `afterEach` to verify resources were cleaned
up.

**Parameters:**

- `options.forceGC` (optional): Whether to force garbage collection before
  checking. Defaults to `false`.
- `options.throwOnLeaks` (optional): Whether to throw an error if leaks are
  detected. Defaults to `true`.
- `options.format` (optional): Output format for error messages. Defaults to
  `"summary"`.
  - `"short"`: Terse, leak count only
  - `"summary"`: List of leaks with counts (default behavior)
  - `"details"`: Detailed output with stack traces showing where leaks were
    created

**Returns:** `Promise<void>`

**Throws:**

- `Error` if tracking is not active (call `track()` first).
- `Error` if leaks are detected and `throwOnLeaks` is `true`. Errors from
  multiple trackers are aggregated.

**Note:** After calling `check()`, tracking is reset. You must call `track()`
again to start a new tracking session. When used in tests, call `track()` again
in the next `beforeEach`. The function checks all active trackers and aggregates
any errors found.

#### Output Formats

##### Short Format

```typescript
await check({ format: 'short' });
// Error: Event listener leaks detected: 5 leaked listener(s)
//
// Timer leaks detected: 2 leaked timer(s)
```

##### Summary Format (Default)

```typescript
await check({ format: 'summary' });
// Error: Event listener leaks detected:
//   Event 'EventEmitter#1.error': expected 0 listener(s), found 1 (+1 leaked)
//   Event 'EventEmitter#1.data': expected 0 listener(s), found 1 (+1 leaked)
//
// Timer leaks detected:
//   setTimeout path/to/file.ts:42:5
//   setInterval path/to/file.ts:88:12
```

##### Details Format

```typescript
await check({ format: 'details' });
// Error: Event listener leaks detected:
//   EventEmitter#1
//   > 'error': expected 0 listener(s), found 2 (+2 leaked)
//       * on('error') path/to/event-listening-file.ts:301:4
//       * once('error') path/to/other/file.ts:22:2
//
// Timer leaks detected:
//   setTimeout path/to/file.ts:42:5
//   setInterval path/to/file.ts:88:12
```

### `snapshot()`

Creates a snapshot of all currently active trackers' state. Returns a record
mapping tracker names to their snapshots. Only includes trackers that are
currently active (i.e., have been started via `track()`).

**Returns:** `Snapshot` - A record of active tracker names to their snapshots.

The return type structure:

```typescript
type Snapshot = {
  eventListeners?: ListenersSnapshot;
  timers?: TimersSnapshot;
};
```

- `eventListeners`: A record mapping emitter identifiers to their event listener
  counts
- `timers`: A record mapping timer types to their counts

**Example:**

```typescript
track();
const emitter = new EventEmitter();
emitter.on('data', handler);
setTimeout(() => {}, 1000);

const snap = snapshot();
// snap = {
//   eventListeners: { 'EventEmitter#1': { data: 1 } },
//   timers: { setTimeout: 1, setInterval: 0 }
// }
```

### `eventListeners`

Convenience object providing access to event listener leak detection functions.

**Properties:**

- `track()` - Starts tracking event listeners on all EventEmitter instances.
- `snapshot()` - Creates a snapshot of current listeners. Returns a
  `ListenersSnapshot` mapping emitter identifiers to their event listener
  counts.
- `check(options?)` - Checks for leaks and restores original EventEmitter
  prototype methods.

**Example:**

```typescript
import { eventListeners } from 'leakspector';

eventListeners.track();
const emitter = new EventEmitter();
emitter.on('data', handler);

const snap = eventListeners.snapshot();
// snap = { 'EventEmitter#1': { data: 1 } }

await eventListeners.check();
```

### `timers`

Convenience object providing access to timer leak detection functions.

**Properties:**

- `track()` - Starts tracking `setTimeout` and `setInterval` calls.
- `snapshot()` - Creates a snapshot of current timers. Returns a
  `TimersSnapshot` mapping timer types to their counts.
- `check(options?)` - Checks for leaks and restores original timer functions.

**Example:**

```typescript
import { timers } from 'leakspector';

timers.track();
setTimeout(() => {}, 1000);

const snap = timers.snapshot();
// snap = { setTimeout: 1, setInterval: 0 }

await timers.check();
```

## License

[Apache-2.0](LICENSE)

```
Copyright 2025 Charles Francoise
```
