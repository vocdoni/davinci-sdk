# Security Policy

## Supported Versions

We actively support the following versions of the Vocdoni DaVinci SDK with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

## Reporting a Vulnerability

The Vocdoni team takes security vulnerabilities seriously. We appreciate your efforts to responsibly disclose your findings and will make every effort to acknowledge your contributions.

### How to Report Security Issues

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities to us via one of the following methods:

#### 1. Email (Preferred)
Send details to: **security@vocdoni.io**

#### 2. GitHub Security Advisories
Use the [GitHub Security Advisory](https://github.com/vocdoni/davinci-sdk/security/advisories/new) feature to privately report vulnerabilities.

### What to Include in Your Report

To help us understand the nature and scope of the possible issue, please include as much of the following information as possible:

- **Vulnerability Type** (e.g., cryptographic flaw, injection vulnerability, etc.)
- **Step-by-step instructions** to reproduce the issue
- **Proof-of-concept or exploit code** (if possible)
- **Impact assessment** - what an attacker might be able to achieve
- **Affected versions** of the SDK
- **Environment details** (Node.js version, browser, etc.)
- **Any potential workarounds** you've identified

### Security Response Process

1. **Acknowledgment**: We will acknowledge receipt of your vulnerability report within 48 hours.

2. **Initial Assessment**: Our security team will perform an initial assessment within 5 business days to determine:
   - Validity of the report
   - Severity level
   - Affected components and versions

3. **Investigation**: We will conduct a thorough investigation and develop a fix plan.

4. **Resolution Timeline**:
   - **Critical**: 1-7 days
   - **High**: 7-30 days
   - **Medium**: 30-90 days
   - **Low**: 90+ days

5. **Disclosure**: Once a fix is available, we will:
   - Release a security update
   - Publish a security advisory
   - Credit you (if desired) in our acknowledgments

## Security Best Practices for Developers

When using the Vocdoni DaVinci SDK, please follow these security best practices:

### 1. Private Key Management
```typescript
// ❌ Never hardcode private keys
const wallet = new Wallet("0x1234..."); 

// ✅ Use environment variables or secure key management
const wallet = new Wallet(process.env.PRIVATE_KEY);
```

### 2. Input Validation
```typescript
// ✅ Always validate user inputs
if (!processId || typeof processId !== 'string') {
  throw new Error('Invalid process ID');
}
```

### 3. Network Configuration
```typescript
// ✅ Use secure RPC endpoints
const sdk = new DavinciSDK({
  signer: wallet,
  environment: 'prod', // Use production for mainnet
  // Avoid using untrusted RPC endpoints
});
```

### 4. Error Handling
```typescript
// ✅ Handle errors securely without exposing sensitive data
try {
  await sdk.submitVote(voteConfig);
} catch (error) {
  // Log error details securely, don't expose to users
  console.error('Vote submission failed:', error.message);
  // Return generic error message to user
  throw new Error('Vote submission failed');
}
```

## Known Security Considerations

### 1. Cryptographic Dependencies
- The SDK relies on `snarkjs` for zero-knowledge proof generation
- Uses `ethers.js` for Ethereum interactions and cryptographic operations
- Regular dependency updates are crucial for security

### 2. Browser Security
- Private keys are handled in-memory during browser usage
- Consider using hardware wallets for production applications
- Be aware of XSS vulnerabilities in web applications

### 3. Network Security
- All API communications use HTTPS
- Verify SSL certificates in production environments
- Be cautious with custom API endpoints

### 4. Proof Generation
- zk-SNARK proof generation uses randomness for privacy
- Ensure adequate entropy sources are available
- Proof generation may be resource-intensive

## Vulnerability Disclosure Policy

We follow a **coordinated disclosure** approach:

1. We request that you give us reasonable time to investigate and fix the issue before public disclosure
2. We will not pursue legal action against researchers who:
   - Act in good faith
   - Don't violate privacy or destroy data
   - Follow responsible disclosure practices
3. We may publicly acknowledge your responsible disclosure (with your permission)

## Security Updates

Security updates will be:

1. **Released promptly** for critical and high-severity issues
2. **Documented** in the [CHANGELOG.md](CHANGELOG.md)
3. **Announced** through:
   - GitHub Security Advisories
   - npm security advisories
   - Project documentation updates
   - Community channels (Discord, Telegram)

## Security Hall of Fame

We recognize security researchers who help improve the security of the Vocdoni DaVinci SDK:

- *No reports received yet*

*If you report a valid security vulnerability, we'll add you here (with your permission).*

## Contact Information

- **Security Team**: security@vocdoni.io
- **General Inquiries**: info@vocdoni.io
- **Community**: [Discord](https://chat.vocdoni.io)

## Additional Resources

- [Vocdoni Security Documentation](https://docs.vocdoni.io/security)
- [DaVinci Protocol Whitepaper](https://whitepaper.vocdoni.io)
- [Smart Contract Audits](https://github.com/vocdoni/davinci-contracts/tree/main/audits)

---

Thank you for helping keep the Vocdoni DaVinci SDK and our community safe!
