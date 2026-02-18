import { getIntegrationTimeoutMs, loadIntegrationEnv } from '../helpers/integrationEnv';

loadIntegrationEnv();
jest.setTimeout(getIntegrationTimeoutMs());
