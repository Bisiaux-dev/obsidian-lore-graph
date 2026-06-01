import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Le module `obsidian` n'est PAS un vrai package installable : Obsidian
 * l'injecte au runtime (cf. esbuild `external: ["obsidian"]`). Pour les tests
 * unitaires on l'alias vers un stub minimal — voir test/__mocks__/obsidian.ts.
 *
 * Périmètre : tests unitaires sur la logique pure (pas de PIXI, pas de DOM,
 * pas d'Obsidian réel). Les interactions avec le renderer restent couvertes
 * par le harness CDP manuel dans _test/.
 */
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/__mocks__/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
