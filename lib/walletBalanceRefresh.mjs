export const BALANCE_REFRESH_MS = 10_000;

export function startBalanceRefresh(pubkey, refreshBalance, timers) {
  const timer = timers.setInterval(() => {
    void refreshBalance(pubkey);
  }, BALANCE_REFRESH_MS);
  return () => timers.clearInterval(timer);
}
