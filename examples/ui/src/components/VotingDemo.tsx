import { useState } from 'react';
import { JsonRpcProvider, Wallet } from 'ethers';
import { VocdoniApiService } from '@vocdoni/davinci-sdk';
import { SmartContractService, OrganizationRegistryService, deployedAddresses } from '@vocdoni/davinci-sdk';

const ORGANIZATION_REGISTRY_ADDR = deployedAddresses.organizationRegistry.sepolia;

export default function VotingDemo() {
  const [status, setStatus] = useState('');
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(false);

  const createOrganization = async () => {
    try {
      setLoading(true);
      setStatus('Initializing...');

      // Initialize provider and wallet
      const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC);
      const wallet = new Wallet(process.env.PRIVATE_KEY || '', provider);
      
      // Initialize API service
      const api = new VocdoniApiService(process.env.API_URL || '');
      
      // Ping API to ensure it's reachable
      setStatus('Pinging API...');
      await api.ping();
      
      // Create organization
      setStatus('Creating organization...');
      const orgService = new OrganizationRegistryService(
        ORGANIZATION_REGISTRY_ADDR,
        wallet
      );
      
      const newOrgId = Wallet.createRandom().address;
      const orgName = `Org-${Date.now()}`;
      const orgMeta = `ipfs://org-meta-${Date.now()}`;

      await SmartContractService.executeTx(
        orgService.createOrganization(newOrgId, orgName, orgMeta, [wallet.address])
      );

      setOrgId(newOrgId);
      setStatus('Organization created successfully!');
    } catch (error) {
      console.error('Error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Vocdoni SDK Demo</h1>
      
      <div className="space-y-6">
        <div className="p-4 border rounded-lg bg-white shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Create Organization</h2>
          <button
            onClick={createOrganization}
            disabled={loading}
            className={`px-4 py-2 rounded-md text-white ${
              loading 
                ? 'bg-gray-400 cursor-not-allowed' 
                : 'bg-blue-500 hover:bg-blue-600'
            }`}
          >
            {loading ? 'Creating...' : 'Create Organization'}
          </button>
          
          {status && (
            <div className="mt-4">
              <p className="text-sm font-medium text-gray-600">Status:</p>
              <p className="text-sm text-gray-800">{status}</p>
            </div>
          )}
          
          {orgId && (
            <div className="mt-4">
              <p className="text-sm font-medium text-gray-600">Organization ID:</p>
              <p className="text-sm text-gray-800 break-all">{orgId}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
