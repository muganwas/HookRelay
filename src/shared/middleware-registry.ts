const chain: string[] = [];

export function resetMiddlewareRegistry(): void {
  chain.length = 0;
}

export function registerMiddleware(name: string): void {
  chain.push(name);
}

export function listMiddleware(): readonly string[] {
  return chain;
}
