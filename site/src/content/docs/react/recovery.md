---
title: Recovery and drafts
description: Reconnect to existing work, preserve unsent input and keep uncertain delivery visible.
---

Run state and connection state are separate. A lost connection does not prove that an agent
failed, completed or stopped. Keep the available answer visible while recovering the view.

## Reconnect without sending again

The client retries observation with a bounded backoff. A successful HTTP handshake alone does
not reset the budget; repeated empty closes eventually show a lost connection with a manual
reconnect action. An unfinished stream is not converted into success.

Sends, uploads and request answers are not replayed automatically. If a send is refused, the
composer keeps the draft. If delivery is unknown, the message stays unconfirmed. Before offering a manual retry, **your app** must check the server's saved conversation. Show Retry only while `canRetry` is true. It is false until the server says where the run stands after the lost reply, and while a run is going, because the message sent again into that run could ask for the same work twice. `retry(messageId)` sends the message again with the same client ID, and `discard(messageId)` removes it without sending it.

An unconfirmed message lives in memory unless you pass `pendingSend` with your storage. Then the
client saves each message before it goes out, brings an unconfirmed one back after a reload, and
keeps one at a time. The composer keeps its words too, so a refused retry loses nothing.

Unmounting or changing account/conversation detaches the old observer. It does not cancel the
server's run. Late events and reads from the old scope cannot update the new one.

## Reconcile saved and live output

Segment/sequence pairs reject duplicate replay. A new physical segment resets the cursor.
Settled parts do not become live again from an old patch. During an active run, a saved snapshot
can preserve newer live output it does not contain yet; a finished snapshot closes that local
uncertainty.

A gap or resync marker says that text may be missing. Recover completed parts from a checkpoint,
not by concatenating fragments as though nothing was lost. There is no guarantee that every
partial token survives worker failure.

Remote artifact text can replace an earlier whole value. A local stop does not confirm that a
remote task stopped, so its last peer state and an unknown outcome remain visible when needed.

## Preserve the draft

`useComposer` protects newer edits from delayed send, upload and draft-save results. Enter sends,
Shift+Enter inserts a line and composition input is handled separately. Attachment-only messages
can be sent when the transport supports them.

Draft storage is opt-in through your `DraftStorage` adapter. Scope it to an authenticated principal
and conversation, and choose retention explicitly. There is no automatic localStorage transcript
capture. Uploaded references can survive reload; an unsent `File` must be chosen again.

Before navigation that depends on saving, await `flushDraft()`. If it returns false, keep the
input available and offer `retryDraft()`. The host owns encryption, access checks and deletion
of expired records.

## Stop honestly

With a stop command, the client waits for the host's result. Without one, it can only stop the
local stream. Neither action rolls back an external effect, and stopping a viewer does not
cancel a remote A2A task. Keep those outcomes distinct in your own controls.
