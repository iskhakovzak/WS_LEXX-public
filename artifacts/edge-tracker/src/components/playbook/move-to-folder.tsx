/** Drag-free "move to folder": searchable folder picker; typing a new name creates the folder. */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, FolderInput, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { invalidatePlaybook } from "./api";
import { http } from "@/lib/api/http";
import { folderSwatch, type PlaybookEntry } from "./model";
import { playbookI18n } from "@/i18n/ns/playbook";
const pt = playbookI18n.t; // called at render time only
import { commonI18n } from "@/i18n/ns/common";

export function useMoveToFolder() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return async (entry: PlaybookEntry, folder: string | null, opts?: { silent?: boolean }) => {
    const prev = entry.folder ?? null;
    if ((folder ?? null) === prev) return true;
    // No `trader` here: on PATCH the API treats a staff-sent `trader` as re-assigning the owner of a personal setup.
    const apply = (f: string | null) => http.patch(`/api/playbook/${entry.id}`, { folder: f });
    try {
      await apply(folder);
      invalidatePlaybook(qc, entry.id);
      if (!opts?.silent) {
        toast({
          title: folder ? pt("move.movedTo", { folder }) : pt("move.movedToUnfiled"),
          description: entry.name,
          action: (
            <ToastAction
              altText={pt("move.undoAlt")}
              onClick={() => apply(prev).then(() => invalidatePlaybook(qc, entry.id), (e) => toast({ title: pt("move.undoFailed"), description: e?.message, variant: "destructive" }))}
            >
              {pt("move.undo")}
            </ToastAction>
          ),
        });
      }
      return true;
    } catch (e: any) {
      toast({ title: pt("move.failed"), description: e?.message, variant: "destructive" });
      return false;
    }
  };
}

export function MoveToFolderButton({
  entry, folders, folderColors, compact,
}: {
  entry: PlaybookEntry;
  folders: string[];
  folderColors: Record<string, number>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const move = useMoveToFolder();
  const typed = search.trim();
  const exists = folders.some((f) => f.toLowerCase() === typed.toLowerCase());

  const pick = async (f: string | null) => {
    setOpen(false);
    setSearch("");
    await move(entry, f);
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8" aria-label={compact ? pt("move.aria") : undefined} title={compact ? pt("move.aria") : undefined}>
          <FolderInput className="h-4 w-4" aria-hidden="true" />
          {!compact && <span>{pt("move.button")}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(300px,calc(100vw-2rem))] p-0" align="end">
        <Command className="bg-transparent">
          <CommandInput value={search} onValueChange={setSearch} placeholder={pt("move.search")} aria-label={pt("move.search")} />
          <CommandList className="max-h-[min(55dvh,440px)]">
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">{pt("move.noFolders")}</CommandEmpty>
            {typed && !exists && (
              <CommandGroup>
                <CommandItem value={`__new ${typed}`} onSelect={() => pick(typed)}>
                  <FolderPlus className="h-4 w-4 text-primary" aria-hidden="true" /> {pt("move.createAndMove", { folder: typed })}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={pt("move.folders")}>
              <CommandItem value={`__none ${commonI18n.t("fields.noFolder")}`} onSelect={() => pick(null)}>
                <Check className={cn("h-4 w-4", !entry.folder ? "opacity-100 text-primary" : "opacity-0")} aria-hidden="true" />
                {commonI18n.t("fields.noFolder")}
              </CommandItem>
              {folders.map((f) => (
                <CommandItem key={f} value={f} onSelect={() => pick(f)}>
                  <Check className={cn("h-4 w-4", entry.folder === f ? "opacity-100 text-primary" : "opacity-0")} aria-hidden="true" />
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", folderSwatch(f, folderColors).bg)} aria-hidden="true" />
                  <span className="truncate">{f}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
