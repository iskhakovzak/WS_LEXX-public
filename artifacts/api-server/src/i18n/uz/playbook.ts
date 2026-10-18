import type { Messages } from "../core";
import type ru from "../ru/playbook";

export default {
  suggest: {
    linked: "Savdo allaqachon setapga bogʻlangan",
    linkedHere: "Savdo shu setapga bogʻlangan",
    auto: "Avtoklassifikatsiya: {label}",
    text: "Nomi savdo belgisi «{label}» ga oʻxshaydi",
  },
} satisfies Messages<typeof ru>;
