import { lazy, Suspense, useEffect, useRef } from "react";
import { MotionConfig } from "framer-motion";
import { RouteErrorBoundary } from "@/components/shell/route-error-boundary";
import { Switch, Route, Redirect, Router as WouterRouter, useLocation, useSearch } from "wouter";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/hooks/use-toast";
import { humanizeApiError, isAuthError, retryDelay, shouldRetryQuery } from "@/lib/api/errors";
import { STALE } from "@/lib/api/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import LoginPage from "@/pages/login";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { BASE } from "@/lib/api";
import { routeTitle } from "@/components/shell/nav";
import { ROUTE_LOADERS, preloadCommonRoutes } from "@/components/shell/route-loaders";
import { I18nProvider } from "@/i18n";
import { LocaleSync } from "@/i18n/locale-sync";
import { shellI18n } from "@/i18n/ns/shell";

// Every section except the dashboard (the landing page) is its own chunk; see shell/route-loaders.ts.
const L = ROUTE_LOADERS;
const Trades = lazy(L["/trades"]);
const Events = lazy(L["/events"]);
const Research = lazy(L["/research"]);
const DailyFeed = lazy(L["/dailyfeed"]);
const Discussions = lazy(L["/discussions"]);
const Analytics = lazy(L["/analytics"]);
const Settings = lazy(L["/settings"]);
const Watchlist = lazy(L["/watchlist"]);
const Playbook = lazy(L["/playbook"]);
const TradeIdeas = lazy(L["/trade-ideas"]);
const TradeIdeaStats = lazy(L["/trade-idea-stats"]);
const Calculator = lazy(L["/calculator"]);
const ActivityPage = lazy(L["/activity"]);
const ErrorTracker = lazy(L["/rules"]);
const Indicators = lazy(L["/indicators"]);
const Big7 = lazy(L["/big7"]);
const Ratings = lazy(L["/ratings"]);
const AnalystActions = lazy(L["/analyst-actions"]);
const Stats = lazy(L["/stats"]);
const Journal = lazy(L["/journal"]);
const TopResults = lazy(L["/top-results"]);
const Admin = lazy(L["/admin"]);
const Curator = lazy(L["/curator"]);
const AuthorNotes = lazy(L["/author-notes"]);
const JuniorNotes = lazy(L["/junior-notes"]);
const Offerings = lazy(L["/offerings"]);
const RiskDesk = lazy(L["/risk"]);
const GamePlan = lazy(L["/game-plan"]);
const Integrations = lazy(L["/integrations"]);
const Scaling = lazy(L["/scaling"]);
const WeeklyReview = lazy(L["/weekly-review"]);
const Notifications = lazy(L["/notifications"]);
const Simulator = lazy(L["/simulator"]);
const WhatIf = lazy(L["/what-if"]);
const Behavior = lazy(L["/behavior"]);
const DayReport = lazy(L["/day-report"]);
const Benchmark = lazy(L["/benchmark"]);
const OfficeStats = lazy(L["/office"]);
const Ask = lazy(L["/ask"]);
const ChartLab = lazy(L["/chart-lab"]);
const DeskDay = lazy(L["/desk-day"]);
const AcademyPath = lazy(L["/academy/path"]);
const AcademyChallenges = lazy(L["/academy/challenges"]);
const AcademyMy = lazy(L["/academy/my"]);
const AcademyMentor = lazy(L["/academy/mentor"]);
const AcademyCohorts = lazy(L["/academy/cohorts"]);
const AcademyLearn = lazy(L["/academy/learn"]);
const AcademyLesson = lazy(L["/academy/lesson"]);
const AcademyContentAdmin = lazy(L["/academy/content-admin"]);

const queryClient = new QueryClient({
  // Any mutation without its own onError gets one toast in the UI language (lib/api/errors). 401s are
  // skipped here: the auth context already shows «Сессия истекла» and returns to the login screen.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.options.onError || isAuthError(error)) return;
      toast({ title: shellI18n.t("app.actionFailed"), description: humanizeApiError(error), variant: "destructive" });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: STALE.default,
      gcTime: 300_000,
      refetchOnWindowFocus: false,
      // Network / 5xx: up to 2 retries with backoff; a 401/403/404/422 answer will not change on retry.
      retry: shouldRetryQuery,
      retryDelay,
    },
    mutations: {
      retry: false,
    },
  },
});

// Mirrors the usual page shape (title, KPI row, content) so the swap to the real page doesn't jump.
const PageFallback = () => (
  <div role="status" aria-busy="true" className="space-y-6">
    <span className="sr-only">{shellI18n.t("app.pageLoading")}</span>
    <div className="space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
    </div>
    <Skeleton className="h-64" />
  </div>
);

const APP_NAME = "WS_LEXX";

/** Keeps the tab title in sync with the current section, and moves focus to the new page for keyboard/SR users. */
function RouteTitle() {
  const [location] = useLocation();
  const search = useSearch();
  const first = useRef(true);
  // Re-run on a language switch too (and when a namespace chunk arrives): `lang` changes the title text.
  const { lang } = shellI18n.useT();
  useEffect(() => {
    const section = routeTitle(location, search);
    document.title = `${section ?? shellI18n.t("titles.notFound")} · ${APP_NAME}`;
  }, [location, search, lang]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    // After client-side navigation, put focus at the top of the new content (not on the old link).
    const main = document.getElementById("main-content");
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
    main?.scrollTo?.({ top: 0 });
  }, [location]);
  return null;
}

function Router() {
  const [location] = useLocation();
  // Trades used to ship in the main bundle; warm its chunk once the first screen is idle so the most common
  // next click stays instant.
  useEffect(() => preloadCommonRoutes(["/trades"]), []);
  return (
    <Layout>
      <RouteTitle />
      <RouteErrorBoundary resetKey={location}>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          {/* Signed in already (the login screen renders outside the router): a typed / bookmarked /login goes home. */}
          <Route path="/login"><Redirect to="/" replace /></Route>
          <Route path="/trades" component={Trades} />
          <Route path="/journal" component={Journal} />
          <Route path="/top-results" component={TopResults} />
          <Route path="/events" component={Events} />
          <Route path="/research" component={Research} />
          <Route path="/dailyfeed" component={DailyFeed} />
          <Route path="/discussions" component={Discussions} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/stats" component={Stats} />
          <Route path="/watchlist" component={Watchlist} />
          <Route path="/playbook" component={Playbook} />
          <Route path="/trade-ideas" component={TradeIdeas} />
          <Route path="/trade-idea-stats" component={TradeIdeaStats} />
          <Route path="/calculator" component={Calculator} />
          <Route path="/activity" component={ActivityPage} />
          <Route path="/rules" component={ErrorTracker} />
          <Route path="/error-tracker" component={ErrorTracker} />
          <Route path="/indicators" component={Indicators} />
          <Route path="/big7" component={Big7} />
          <Route path="/ratings" component={Ratings} />
          <Route path="/analyst-actions" component={AnalystActions} />
          <Route path="/settings" component={Settings} />
          <Route path="/admin" component={Admin} />
          <Route path="/curator" component={Curator} />
          <Route path="/author-notes" component={AuthorNotes} />
          <Route path="/junior-notes" component={JuniorNotes} />
          <Route path="/offerings" component={Offerings} />
          <Route path="/risk" component={RiskDesk} />
          <Route path="/game-plan" component={GamePlan} />
          <Route path="/integrations" component={Integrations} />
          <Route path="/scaling" component={Scaling} />
          <Route path="/weekly-review" component={WeeklyReview} />
          <Route path="/notifications" component={Notifications} />
          <Route path="/simulator" component={Simulator} />
          <Route path="/what-if" component={WhatIf} />
          <Route path="/behavior" component={Behavior} />
          <Route path="/day-report" component={DayReport} />
          <Route path="/benchmark" component={Benchmark} />
          <Route path="/office" component={OfficeStats} />
          <Route path="/ask" component={Ask} />
          <Route path="/chart-lab" component={ChartLab} />
          <Route path="/desk-day" component={DeskDay} />
          <Route path="/academy/path" component={AcademyPath} />
          <Route path="/academy/challenges" component={AcademyChallenges} />
          <Route path="/academy/my" component={AcademyMy} />
          <Route path="/academy/mentor" component={AcademyMentor} />
          <Route path="/academy/cohorts" component={AcademyCohorts} />
          <Route path="/academy/learn" component={AcademyLearn} />
          <Route path="/academy/lesson" component={AcademyLesson} />
          <Route path="/academy/content-admin" component={AcademyContentAdmin} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
      </RouteErrorBoundary>
    </Layout>
  );
}

function AppContent() {
  const { isAuthenticated } = useAuth();

  // Drop every cached response on logout / session expiry so the next user never sees the
  // previous user's data flash in before refetching.
  const wasAuthed = useRef(isAuthenticated);
  useEffect(() => {
    if (wasAuthed.current && !isAuthenticated) queryClient.clear();
    wasAuthed.current = isAuthenticated;
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    document.title = `${shellI18n.t("titles.login")} · ${APP_NAME}`;
    return <LoginPage />;
  }

  return (
    <WouterRouter base={BASE}>
      <Router />
    </WouterRouter>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* framer-motion follows the OS «reduce motion» setting everywhere (transforms/layout off, opacity kept). */}
      <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <AuthProvider>
          <ThemeProvider>
            <LocaleSync />
            {/* Re-mounts the app on a language switch (query cache, auth and theme survive; see i18n/README.md). */}
            <I18nProvider>
              {/* Last line of defence: a crash in the shell itself (header, sidebar) shows a retry instead of a blank page. */}
              <RouteErrorBoundary resetKey="app">
                <AppContent />
              </RouteErrorBoundary>
            </I18nProvider>
          </ThemeProvider>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}

export default App;
