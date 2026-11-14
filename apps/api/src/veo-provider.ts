import type { ProviderCapabilities } from '@memories/shared';
import { VideoProviderError, type VideoGenerationProvider, type VideoSubmission, type ProviderVideoOperation, type ProviderVideoOutput } from './video-provider.js';

/** Kept as a modular migration boundary; retired Gemini Veo previews are never submitted. */
export class VeoProvider implements VideoGenerationProvider {
  constructor(private readonly model='veo-3.1-fast-generate-preview') {}
  capabilities():ProviderCapabilities {return {provider:'veo',backend:'gemini',model:this.model,available:false,accountVerified:false,unavailabilityReason:'Google shut down Veo 3.1 preview models in the Gemini API on October 22, 2026. Choose the supported Gemini Omni provider. Google Cloud GA Veo uses a different backend and is not silently substituted.',supportedModes:[],durationsSeconds:[],resolutions:[],aspectRatios:[],audioModes:[],supportsCancellation:false,supportsRefinement:false,pollIntervalMs:15000,pricePerSecondUsd:0,priceVerifiedAt:'2026-11-14'};}
  private unavailable():never {throw new VideoProviderError(410,'VIDEO_PROVIDER_RETIRED',this.capabilities().unavailabilityReason!,'rejected');}
  async submit(_request:VideoSubmission,_signal:AbortSignal):Promise<ProviderVideoOperation> {return this.unavailable();}
  async poll(_operationId:string,_signal:AbortSignal):Promise<ProviderVideoOperation> {return this.unavailable();}
  async download(_output:ProviderVideoOutput,_signal:AbortSignal):Promise<Response> {return this.unavailable();}
}
