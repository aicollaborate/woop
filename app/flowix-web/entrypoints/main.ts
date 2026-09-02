// The Vite alias is resolved at build time to the desktop entrypoint.
// Keep this bootstrap free of product imports so the application root stays
// explicit in the dependency graph.
import "@flowix-target-entry";
