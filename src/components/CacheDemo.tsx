import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { cacheService } from '@/services/cacheService';
import { useCache } from '@/hooks/useCache';

// Mock API function
const fetchUserData = async (userId: string) => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  return {
    id: userId,
    name: `User ${userId}`,
    email: `user${userId}@example.com`,
    lastLogin: new Date().toISOString(),
    preferences: {
      theme: 'dark',
      notifications: true
    }
  };
};

export function CacheDemo() {
  const [userId, setUserId] = useState('123');
  const [cacheKey, setCacheKey] = useState('');
  const [cacheValue, setCacheValue] = useState('');
  const [ttl, setTtl] = useState('300');
  const { toast } = useToast();

  // Using the cache hook
  const { 
    data: userData, 
    loading, 
    error, 
    refresh, 
    invalidate 
  } = useCache(
    `user-${userId}`,
    () => fetchUserData(userId),
    { ttl: 300 } // 5 minutes cache
  );

  const handleManualSet = async () => {
    if (!cacheKey || !cacheValue) {
      toast({
        title: "Error",
        description: "Please provide both key and value",
        variant: "destructive"
      });
      return;
    }

    try {
      await cacheService.set(cacheKey, cacheValue, parseInt(ttl) || undefined);
      toast({
        title: "Success",
        description: `Cached "${cacheKey}" with value "${cacheValue}"`
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to set cache",
        variant: "destructive"
      });
    }
  };

  const handleManualGet = async () => {
    if (!cacheKey) {
      toast({
        title: "Error",
        description: "Please provide a cache key",
        variant: "destructive"
      });
      return;
    }

    try {
      const value = await cacheService.get(cacheKey);
      toast({
        title: "Cache Value",
        description: value ? `"${value}"` : "Key not found or expired"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to get cache",
        variant: "destructive"
      });
    }
  };

  const handleClearCache = async () => {
    try {
      await cacheService.clear();
      toast({
        title: "Success",
        description: "All cache cleared"
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to clear cache",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold mb-2">Redis Cache Demo</h1>
        <p className="text-muted-foreground">
          This demonstrates Redis caching functionality (mock implementation in Lovable)
        </p>
      </div>

      {/* User Data Cache Demo */}
      <Card>
        <CardHeader>
          <CardTitle>User Data Caching</CardTitle>
          <CardDescription>
            Demonstrates automatic caching with the useCache hook
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <Label htmlFor="userId">User ID:</Label>
            <Input
              id="userId"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-32"
            />
            <Button onClick={refresh} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </Button>
            <Button onClick={invalidate} variant="outline">
              Invalidate Cache
            </Button>
          </div>

          {error && (
            <div className="text-red-500">Error: {error.message}</div>
          )}

          {userData && (
            <div className="bg-muted p-4 rounded-lg">
              <h3 className="font-semibold mb-2">Cached User Data:</h3>
              <pre className="text-sm overflow-auto">
                {JSON.stringify(userData, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual Cache Operations */}
      <Card>
        <CardHeader>
          <CardTitle>Manual Cache Operations</CardTitle>
          <CardDescription>
            Test cache set/get operations directly
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="cacheKey">Cache Key</Label>
              <Input
                id="cacheKey"
                value={cacheKey}
                onChange={(e) => setCacheKey(e.target.value)}
                placeholder="my-cache-key"
              />
            </div>
            <div>
              <Label htmlFor="cacheValue">Cache Value</Label>
              <Input
                id="cacheValue"
                value={cacheValue}
                onChange={(e) => setCacheValue(e.target.value)}
                placeholder="any value"
              />
            </div>
            <div>
              <Label htmlFor="ttl">TTL (seconds)</Label>
              <Input
                id="ttl"
                type="number"
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                placeholder="300"
              />
            </div>
          </div>

          <div className="flex space-x-2">
            <Button onClick={handleManualSet}>Set Cache</Button>
            <Button onClick={handleManualGet} variant="outline">
              Get Cache
            </Button>
            <Button onClick={handleClearCache} variant="destructive">
              Clear All Cache
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Cache Information */}
      <Card>
        <CardHeader>
          <CardTitle>Cache Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <p><strong>Environment:</strong> {process.env.NODE_ENV || 'development'}</p>
            <p><strong>Redis Mode:</strong> Mock (for Lovable demo)</p>
            <p><strong>Production Mode:</strong> Would connect to Docker Redis</p>
            <p><strong>Features:</strong></p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>Automatic caching with hooks</li>
              <li>TTL (Time To Live) support</li>
              <li>User-specific caching</li>
              <li>API response caching</li>
              <li>Cache invalidation</li>
              <li>Session management</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}