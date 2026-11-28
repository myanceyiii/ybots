// String.prototype.toWellFormed (ES2024) is in Node 22; the server's TypeScript target is ES2023, so it is declared here for recorder-masking.ts.
interface String { toWellFormed(): string }
