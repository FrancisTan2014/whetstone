import { getSchema } from "@tiptap/core";
import type { Schema } from "prosemirror-model";

import { documentExtensions } from "./nodes.js";

// The single ProseMirror schema for whetstone content, built from the node specs in Node with no
// browser (the JSON path is pure; DOM parsing only enters at HTML ingestion). Every slice — storage,
// reader, future editor — validates and constructs documents against this one schema. Stable node ids
// are assigned through `assignNodeIds` (Tiptap UniqueID's server-side generator).
export const documentSchema: Schema = getSchema(documentExtensions);
