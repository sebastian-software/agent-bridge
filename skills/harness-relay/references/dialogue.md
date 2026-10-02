# Talking to a delegate

Check capabilities on the exact CLI or MCP server before using these
operations. A harness that supports something natively is not enough: the
selected Relay route must advertise the capability. Keep the original
invocation ID.

## Add an instruction while it runs (`steering`)

For a route advertising `steering`, send a bounded instruction with an
invocation-scoped idempotency key:

```sh
harness-relay send <invocation-id> \
  --idempotency-key add-regression-case-1 \
  --text "Also cover the empty-input case." --json
```

Use the same executable that passed bootstrap and follow the invocation's
events afterwards. `input_accepted` means the broker recorded the request;
`input_delivered` means the native session acknowledged it. Neither proves that
the model followed the instruction. Pending, failed, or expired deliveries stay
visible. Retry with the same key and identical content; a new key creates
another instruction. Sending does not interrupt a running tool; cancel the
invocation explicitly to stop it.

## Continue after completion (`continuation`)

When a finished invocation's route advertises `continuation`:

```sh
harness-relay continue <invocation-id> \
  --idempotency-key review-completed-change-1 \
  --text "Review the change you just made and report remaining risks." --json
```

This starts a new invocation with its own ID and outcome; the predecessor's
outcome does not change. A missing, expired, or changed native session is an
explicit failure. Do not replace it with a fresh conversation; the caller
decides whether to start over.

## Questions and permissions

Answer a correlated general question with `invocation.answer`, using the
request ID from its `input_required` event. Permission requests take `allow` or
`deny` through `invocation.respond`. Do not treat ordinary assistant prose as a
question, or a permission approval as a general answer.
