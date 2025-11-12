# leakspector

A Node.js library for detecting memory leaks. Track resources at the start of
each test and verify they're cleaned up at the end.

## Overview

leakspector helps you catch memory leaks in your tests by tracking resource
usage and comparing it against the initial state. Currently tracks:

- **Event listeners** on EventEmitter instances

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

Leakspector is best used in conjunction with a test runner like Vitest.

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
    // Forgot to remove handler - test will fail in afterEach
  });
});
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

### Suppress Errors (Debug Mode)

To check for leaks without failing tests:

```typescript
afterEach(async () => {
  await check({ throwOnLeaks: false });
  // Leaks will be logged to console.error instead
});
```

## API

### `track()`

Starts tracking resources. Call this in `beforeEach` before creating any
resources you want to track.

**Throws:** `Error` if tracking is already active. Call `check()` first to
reset.

### `check(options?)`

Checks for leaks by comparing current resource usage against the initial state.
Call this in `afterEach`.

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
- `Error` if leaks are detected and `throwOnLeaks` is `true`.

**Note:** After calling `check()`, tracking is reset. You must call `track()`
again in the next `beforeEach` to start a new tracking session.

#### Output Formats

##### Short Format

```typescript
await check({ format: 'short' });
// Error: Event listener leaks detected: 5 leaked listener(s)
```

##### Summary Format (Default)

```typescript
await check({ format: 'summary' });
// Error: Event listener leaks detected:
//   Event 'EventEmitter#1.error': expected 0 listener(s), found 1 (+1 leaked)
//   Event 'EventEmitter#1.data': expected 0 listener(s), found 1 (+1 leaked)
```

##### Details Format

```typescript
await check({ format: 'details' });
// Error: Event listener leaks detected:
//   EventEmitter#1 path/to/constructor-call.ts:41:4
//   > Event 'error': expected 0 listener(s), found 2 (+2 leaked)
//       * on('error') path/to/event-listening-file.ts:301:4
//       * once('error') path/to/other/file.ts:22:2
```

## What Gets Tracked

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

## License

Apache-2.0
