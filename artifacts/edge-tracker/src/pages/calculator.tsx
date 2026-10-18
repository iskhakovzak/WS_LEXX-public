/**
 * /calculator — options only: chain + advisor, single-option Black-Scholes, multi-leg strategy builder with payoff.
 * (Position sizer and FX converter were removed from the page by the owner's decision — the files stay in
 * components/calculator/ but are not rendered.) Sections live in src/components/calculator/*.
 * ?ticker=XYZ prefills the ticker in every options view.
 */
import { BarChart3 } from "lucide-react";
import { Page, PageHeader } from "@/components/ds";
import OptionsSection from "@/components/calculator/OptionsSection";
import { calculatorI18n } from "@/i18n/ns/calculator";

function tickerParam(): string | undefined {
  try {
    const t = new URLSearchParams(window.location.search).get("ticker")?.trim().toUpperCase();
    return t && /^[A-Z.\-]{1,10}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

export default function CalculatorPage() {
  const { t } = calculatorI18n.useT();
  return (
    <Page>
      <PageHeader
        title={t("page.title")}
        icon={BarChart3}
        description={t("page.description")}
      />
      <OptionsSection initialTicker={tickerParam()} />
    </Page>
  );
}
