declare module '@ducanh2912/next-pwa' {
    import type { NextConfig } from 'next';

    interface PWAConfig {
        dest: string;
        disable?: boolean;
        register?: boolean;
        skipWaiting?: boolean;
        [key: string]: unknown;
    }

    function withPWA(config: PWAConfig): (nextConfig: NextConfig) => NextConfig;

    export default withPWA;
}
