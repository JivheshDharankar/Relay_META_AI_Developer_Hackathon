import { ModelProvider, ModelProviderError } from './ModelProvider';
import { MockModelProvider } from './MockModelProvider';
import { MetaModelProvider } from './MetaModelProvider';
import { MetaSparkProvider } from './MetaSparkProvider';
import { SparkOpenProvider } from './SparkOpenProvider';
import { env } from '../../config/env';

export * from './types';
export * from './ModelProvider';
export * from './openaiWireFormat';
export * from './MockModelProvider';
export * from './MetaModelProvider';
export * from './MetaSparkProvider';
export * from './SparkOpenProvider';

/**
 * Factory function to retrieve the configured or requested ModelProvider.
 * Defaults to 'mock' in test/development environments.
 */
export function getModelProvider(providerName?: string): ModelProvider {
  const chosen = providerName || env.MODEL_PROVIDER;

  switch (chosen) {
    case 'meta':
    case 'meta-spark':
      return new MetaSparkProvider();
    case 'meta-model':
      return new MetaModelProvider();
    case 'open':
    case 'spark-open':
      return new SparkOpenProvider();
    case 'mock':
      return new MockModelProvider();
    default:
      // Fail closed: an unrecognized provider name must never silently
      // degrade the deployment to deterministic mock behavior.
      throw new ModelProviderError(
        'UNKNOWN_MODEL_PROVIDER',
        `Unknown model provider '${chosen}'. Supported providers: mock, meta, meta-spark, meta-model, spark-open.`
      );
  }
}
