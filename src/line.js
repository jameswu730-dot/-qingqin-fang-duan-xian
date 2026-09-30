export function createLine(token, fetchImpl = fetch) {
  return async (kind, destination, text, retryKey) => {
    const body = kind === 'reply' ? {replyToken:destination} : {to:destination};
    const response = await fetchImpl(`https://api.line.me/v2/bot/message/${kind}`, {
      method:'POST', signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,
        ...(kind === 'push' ? {'X-Line-Retry-Key':retryKey} : {})},
      body:JSON.stringify({...body,messages:[{type:'text',text}]})
    });
    // LINE 409 with accepted request ID means this retry key was already accepted.
    if (response.ok || (kind==='push' && response.status===409 && response.headers.get('x-line-accepted-request-id'))) return;
    const e = new Error('line_request_failed');
    e.retryable = response.status===429 || response.status>=500;
    throw e;
  };
}
