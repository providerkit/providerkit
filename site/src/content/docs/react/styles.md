---
title: Styling
description: Use optional defaults, plain CSS or Tailwind without changing the chat state owner.
---

Load the default styles only when you want them:

```ts
import "@providerkit/react/styles.css";
```

Hook imports load no CSS. The stylesheet is scoped to the library's `pk-*` components, has no
global reset and inherits the host's typography. Every part has a class and `data-part`; stateful
parts also expose `data-state`.

## Use your own CSS

Add a class through the normal component prop:

```tsx
<Conversation chat={chat} className="support-chat" />
```

The defaults use the `providerkit` cascade layer and low-specificity `:where()` selectors. Your
unlayered styles win without selector escalation. Keep visible keyboard focus, reduced-motion
behavior and readable pending/error states when replacing the defaults.

You can omit the stylesheet entirely and style the plain-data components yourself. Keep the
same action and acknowledgement behavior; changing a button's appearance must not make an
uncertain request look complete.

## Use Tailwind

Tailwind is not a dependency. Place the package defaults in the component layer before utilities:

```css
@import "tailwindcss";
@import "@providerkit/react/styles.css" layer(components);
```

Then use normal `className` values on the exported components. You do not need a providerkit
preset or a second theme store.

## Translate the controls

The labels object supplies the default English UI text and supports application overrides.
Tool labels can be mapped by tool name, and specialist labels by registered identity or run ID.
A server label remains the fallback. Keep remote unknown status distinct from confirmed
cancellation in every language.

Use the [component reference](/reference/react/) for props and label types. The
[chat demo](/demos/chat/) uses the real components styled for this site.
