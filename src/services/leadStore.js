const store = new Map();

export function saveLead(callSid, data) {
  store.set(callSid, {
    ...data,
    savedAt: Date.now()
  });

  // Auto-expire after 10 minutes
  setTimeout(() => store.delete(callSid), 10 * 60 * 1000);
}

export function getLead(callSid) {
  return store.get(callSid) || null;
}
