// Minimal UIMessage-stream (SSE) client for node eval scripts against
// /api/chat. Collects text, tool calls (with parsed inputs), and errors
// into the same flat shape the old JSON assertions used.

export async function chatTurn(base, secret, body) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dev-secret": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let err = `HTTP ${res.status}`;
    try {
      err = (await res.json()).error ?? err;
    } catch {
      /* not json */
    }
    return { ok: false, error: err, reply: "", toolCalls: [], message: null };
  }

  const chunks = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        chunks.push(JSON.parse(payload));
      } catch {
        /* keepalive */
      }
    }
  }

  // Fold chunks into text + tool calls + the final UIMessage parts.
  let reply = "";
  const toolCalls = [];
  const toolInputs = new Map(); // toolCallId -> {toolName, inputText}
  const toolOutputs = new Map();
  let messageId = null;
  let error = null;
  for (const c of chunks) {
    switch (c.type) {
      case "start":
        messageId = c.messageId ?? messageId;
        break;
      case "text-delta":
        reply += c.delta ?? "";
        break;
      case "tool-input-start":
        toolInputs.set(c.toolCallId, { toolName: c.toolName, inputText: "" });
        break;
      case "tool-input-delta": {
        const t = toolInputs.get(c.toolCallId);
        if (t) t.inputText += c.inputTextDelta ?? "";
        break;
      }
      case "tool-input-available":
        toolInputs.set(c.toolCallId, {
          toolName: c.toolName,
          input: c.input,
        });
        break;
      case "tool-input-error":
        // Schema/validation rejection (e.g. geometry guard) — the model saw
        // the error; the call must NOT count as an applied action.
        toolInputs.set(c.toolCallId, {
          toolName: c.toolName,
          input: c.input,
          errored: true,
          errorText: c.errorText,
        });
        break;
      case "tool-output-available":
        toolOutputs.set(c.toolCallId, c.output);
        break;
      case "tool-output-error":
        toolOutputs.set(c.toolCallId, { error: c.errorText });
        break;
      case "error":
        error = c.errorText ?? "stream error";
        break;
    }
  }
  for (const [id, t] of toolInputs) {
    let input = t.input;
    if (input === undefined && t.inputText) {
      try {
        input = JSON.parse(t.inputText);
      } catch {
        input = t.inputText;
      }
    }
    toolCalls.push({
      toolCallId: id,
      toolName: t.toolName,
      input,
      output: toolOutputs.get(id),
      errored: t.errored === true,
    });
  }

  // Reconstruct an assistant UIMessage (for tool-result continuations).
  const parts = [];
  if (reply) parts.push({ type: "text", text: reply });
  for (const tc of toolCalls) {
    parts.push({
      type: `tool-${tc.toolName}`,
      toolCallId: tc.toolCallId,
      state: tc.output !== undefined ? "output-available" : "input-available",
      input: tc.input,
      ...(tc.output !== undefined ? { output: tc.output } : {}),
    });
  }
  return {
    ok: !error,
    error,
    reply,
    toolCalls,
    message: { id: messageId ?? `a${Date.now()}`, role: "assistant", parts },
  };
}

/** Answer pending client-tool calls (simulating the browser) and continue
 *  the turn until no unresolved client tools remain. Returns the merged
 *  result of all rounds. */
export async function chatTurnWithClientTools(base, secret, body, executeClientTool) {
  // Local thread so continuations keep the original user message even
  // without a conversationId (the server accepts `messages` as history).
  const thread = body.messages ? [...body.messages] : [body.message];
  let round = await chatTurn(base, secret, body);
  const allCalls = [...round.toolCalls];
  let combinedReply = round.reply;
  for (let i = 0; i < 4; i++) {
    const pending = round.message?.parts.filter(
      (p) => p.type?.startsWith("tool-") && p.state === "input-available",
    );
    if (!round.ok || !pending?.length) break;
    for (const p of pending) {
      const name = p.type.slice(5);
      p.output = await executeClientTool(name, p.input);
      p.state = "output-available";
    }
    thread.push(round.message);
    round = await chatTurn(base, secret, {
      ...body,
      message: round.message,
      messages: thread,
    });
    allCalls.push(...round.toolCalls);
    combinedReply += (combinedReply && round.reply ? "\n" : "") + round.reply;
  }
  return { ...round, reply: combinedReply, toolCalls: allCalls };
}
