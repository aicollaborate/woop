// The Vite alias is resolved at build time to exactly one target entrypoint.
// Keep this bootstrap free of product imports so mobile cannot accidentally
// retain a desktop application root in its dependency graph.
import "@flowix-target-entry";
