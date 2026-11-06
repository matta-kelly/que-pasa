/**
 * que-pasa: que2's harness, on basis. It defines no types of its own yet. It imports it for the root note's type.
 */

import { defineSchema } from "@mku1tra/basis";
import it from "@mku1tra/it";

export default defineSchema({
  name: "que-pasa",
  description: "que2's harness: it knows no company.",
  types: {},
  imports: [it],
  typeNotes: new URL("./types/", import.meta.url),
  notes: new URL("./", import.meta.url),
  // The README is for npm and GitHub, with no frontmatter: not a note.
  skip: (path) => path === "README.md",
  exports: () => import("./schema.ts"),
});
