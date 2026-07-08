import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { logger } from './logger.js';

const proxyUrl = process.env.PROXY_URL || '';

const agent = proxyUrl
  ? new SocksProxyAgent(proxyUrl)
  : undefined;

if (agent) {
  logger.info({ proxyUrl }, 'Transport: SOCKS5 proxy configured');
}

export const httpClient = agent
  ? axios.create({ httpAgent: agent, httpsAgent: agent })
  : axios;
