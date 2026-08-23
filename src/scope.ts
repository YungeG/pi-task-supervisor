let enabled = false;

export function setSessionScopeEnabled(value: boolean): void {
  enabled = value;
}

export function isSessionScopeEnabled(): boolean {
  return enabled;
}
