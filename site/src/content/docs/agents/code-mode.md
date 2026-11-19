---
title: Code mode
description: Let a model combine registered tools in a bounded JavaScript program, without granting new capabilities.
---

Run the offline code-mode example:

```sh
bun node_modules/@providerkit/agents/examples/code-mode.ts
```

It prints `Total: 9`. [The complete source](https://github.com/providerkit/providerkit/blob/340d8af/agents/examples/code-mode.ts)
uses a real QuickJS runtime and sample tools, not a paid model.

## Install the optional engine

```sh
bun add @providerkit/agents@0.3.0 @providerkit/core@^0.33.1
bun add quickjs-emscripten-core@^0.32.0 @jitl/quickjs-wasmfile-release-sync@^0.32.0
```

Import `codeMode` from `@providerkit/agents/code-mode` and `createQuickJsDriver` from
`@providerkit/agents/code-mode/quickjs`. Normal agent imports load no engine. You can supply a
`CodeDriver` of your own through the same bounded job contract.

## Keep the tool catalog fixed

The host binds ordinary Core tools. A program can call only the enabled subset of those tools;
source text cannot grant another capability. Questions, client actions, delegation and other
control tools stay in the normal agent flow. Reuse the same object when a tool is registered both
directly and through code mode.

Every inner call uses the shared authorization, guard, retry and accounting path. It receives a
real operation ID and attempt receipt, with its outer program recorded as the parent. It is not
a separate agent or a fabricated model turn.

`Tool.outputSchema` supplies optional generated typings. Those types help the model write code;
they do not validate results or change a provider's schema enforcement.

## Bound the program and its output

The default program has at most 32 calls and a 30-second wall limit. Source, results, logs and
individual call input/output also have byte limits. `CodeLimits` lists each bound. A fresh runtime
runs each job; there is no network, filesystem, process or import access inside the guest.

Your host tools still run in the host process. QuickJS is not a sandbox for those implementations.
A blocking host callback can also block cancellation; move such work behind a host boundary that
can enforce its own limits. Browser/Workers deployment of this driver is not verified here.

## Restore data, not a VM

When a program ends, admitted calls are aborted and settled before finalization. Stored inner
results are bounded previews, while the program can use the full live return. Source, logs,
arguments and results stay private by default in React projection and tracing.

A restart does not restore a half-running VM. Unknown writes are never replayed automatically.
An explicit read-only recovery policy may restart a program only when the recorded effects allow
it. Offline evals can validate its saved data without constructing executable tools; resuming
still requires the real registered bindings and current host permission.

See [the code-mode API](/reference/agents/), [evals](/agents/evals/) and [recovery](/agents/recovery/).
