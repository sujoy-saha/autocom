import { config } from "../config.js";
import { memoryStore } from "./memoryStore.js";
import { supabaseStore } from "./supabaseStore.js";
import type { DataStore } from "./types.js";

export const db: DataStore = config.isDemoStore ? memoryStore : supabaseStore;
export * from "./types.js";
