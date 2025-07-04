import { useState, useEffect, useCallback } from 'react';
import { cacheService } from '@/services/cacheService';

interface UseCacheOptions {
  ttl?: number; // Time to live in seconds
  refreshInterval?: number; // Auto refresh interval in milliseconds
}

export function useCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: UseCacheOptions = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { ttl, refreshInterval } = options;

  const fetchData = useCallback(async (useCache: boolean = true) => {
    try {
      setLoading(true);
      setError(null);

      // Try to get from cache first
      if (useCache) {
        const cachedData = await cacheService.get<T>(key);
        if (cachedData) {
          setData(cachedData);
          setLoading(false);
          return cachedData;
        }
      }

      // Fetch fresh data
      const freshData = await fetcher();
      
      // Cache the result
      await cacheService.set(key, freshData, ttl);
      
      setData(freshData);
      setLoading(false);
      return freshData;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      setLoading(false);
      throw error;
    }
  }, [key, fetcher, ttl]);

  const refresh = useCallback(() => {
    return fetchData(false);
  }, [fetchData]);

  const invalidate = useCallback(async () => {
    await cacheService.delete(key);
    return fetchData(false);
  }, [key, fetchData]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto refresh interval
  useEffect(() => {
    if (!refreshInterval) return;

    const interval = setInterval(() => {
      fetchData(false);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [fetchData, refreshInterval]);

  return {
    data,
    loading,
    error,
    refresh,
    invalidate,
    refetch: refresh
  };
}

// Hook for user-specific cached data
export function useUserCache<T>(
  userId: string,
  dataKey: string,
  fetcher: () => Promise<T>,
  options: UseCacheOptions = {}
) {
  return useCache(`user:${userId}:${dataKey}`, fetcher, options);
}

// Hook for API response caching
export function useApiCache<T>(
  endpoint: string,
  params: Record<string, any> = {},
  fetcher: () => Promise<T>,
  options: UseCacheOptions = {}
) {
  const cacheKey = `api:${endpoint}:${JSON.stringify(params)}`;
  return useCache(cacheKey, fetcher, options);
}