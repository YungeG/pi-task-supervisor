// Run the same isolated real-SDK/faux-provider harness through the opt-in path.
// The synthetic command callbacks certify plumbing, not real business permission.
process.argv.push("--preflight");
await import("./real-pi-smoke.mjs");
