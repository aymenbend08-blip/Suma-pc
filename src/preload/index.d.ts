import type { SumaApi } from "./index";

declare global {
  interface Window {
    suma: SumaApi;
  }
}
