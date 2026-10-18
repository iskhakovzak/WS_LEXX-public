/**
 * «Сделать правилом» для поведенческого паттерна.
 *   — есть подходящий вид правила деска (овертрейдинг → max_trades_per_day, тильт → no_trade_after_n_losses):
 *     POST /api/rules — правило попадает в раздел «Правила», сканер нарушений проверяет его сам;
 *   — иначе: личный триггер (POST /api/behavior/triggers) — блок «Мои триггеры» на этой странице.
 * Рядом — копирование текста правила в буфер (для плана дня / заметки).
 */
import * as React from "react";
import { Check, Copy, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useCreateDeskRule, useCreateTrigger, type PatternInsight, type PatternKey } from "./api";
import { behaviorI18n } from "@/i18n/ns/behavior";

const tb = behaviorI18n.t;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const MakeRuleButton = React.memo(function MakeRuleButton({
  insight, patternKey, patternTitle, trader, canEdit,
}: {
  insight: PatternInsight;
  patternKey: PatternKey;
  patternTitle: string;
  trader: string | null;
  canEdit: boolean;
}) {
  const deskRule = useCreateDeskRule();
  const trigger = useCreateTrigger();
  const [copied, setCopied] = React.useState(false);
  const [made, setMade] = React.useState(false);
  const busy = deskRule.isPending || trigger.isPending;

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const onMake = () => {
    if (!trader) return;
    const onError = (e: unknown) =>
      toast({ title: tb("makeRule.createFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    if (insight.rule) {
      deskRule.mutate({ trader, rule: insight.rule }, {
        onSuccess: (r) => {
          setMade(true);
          toast({
            title: r.existing ? tb("makeRule.ruleExists") : tb("makeRule.ruleAdded"),
            description: tb("makeRule.ruleAddedHint", { name: insight.rule!.name }),
          });
        },
        onError,
      });
      return;
    }
    const t = insight.trigger;
    trigger.mutate({
      trader,
      kind: t.kind,
      params: t.params,
      name: t.kind === "custom" ? insight.ruleText : t.name,
      note: t.kind === "custom" ? undefined : insight.ruleText,
      sourcePattern: patternKey,
    }, {
      onSuccess: (r) => {
        setMade(true);
        toast({
          title: r.existing ? tb("makeRule.triggerExists") : tb("makeRule.triggerAdded"),
          description: tb("makeRule.triggerAddedHint", { name: t.kind === "custom" ? insight.ruleText : t.name }),
        });
      },
      onError,
    });
  };

  const onCopy = async () => {
    const ok = await copyText(insight.ruleText);
    if (ok) setCopied(true);
    else toast({ title: tb("makeRule.noClipboard"), description: insight.ruleText });
  };

  return (
    <div className="inline-flex items-center gap-1">
      {canEdit && trader && (
        <Button
          size="sm"
          variant={made ? "outline" : "default"}
          onClick={onMake}
          disabled={busy}
          aria-busy={busy}
          title={insight.rule ? tb("makeRule.titleRule") : tb("makeRule.titleTrigger")}
          aria-label={tb("makeRule.aria", { pattern: patternTitle })}
        >
          {made ? <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> : <ListPlus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
          {made ? (insight.rule ? tb("makeRule.inRules") : tb("makeRule.inTriggers")) : tb("makeRule.make")}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void onCopy()} aria-label={tb("makeRule.copyAria", { pattern: patternTitle })} title={tb("makeRule.copyTitle")}>
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        {!canEdit && <span className="ml-1">{tb("makeRule.copy")}</span>}

      </Button>
    </div>
  );
});
