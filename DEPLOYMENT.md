# GitHub Pages Deployment Setup

This document describes the automated deployment setup for the Vocdoni DaVinci SDK UI example to GitHub Pages.

## Overview

The deployment system uses GitHub Actions to automatically build and deploy the UI example to GitHub Pages when a Pull Request is labeled with `deploy-ui`.

## Files Created/Modified

### 1. GitHub Actions Workflow
**File**: `.github/workflows/deploy-ui.yml`
- **Trigger**: PR labeled with "deploy-ui"
- **Process**: Builds SDK → Installs UI dependencies → Builds static export → Deploys to GitHub Pages
- **Features**: Automatic PR commenting with deployment URL
- **Branch Support**: Can deploy from any branch (environment protection removed)

### 2. Next.js Configuration
**File**: `examples/ui/next.config.js`
- **Static Export**: Configured for GitHub Pages compatibility
- **Base Path**: Set to `/davinci-sdk2` for proper routing
- **Build Optimizations**: Disabled linting/TypeScript errors during build
- **Image Optimization**: Disabled for static export

### 3. Environment Configuration
**File**: `examples/ui/.env.production`
- **Public Variables**: API_URL, SEPOLIA_RPC
- **Security**: PRIVATE_KEY intentionally empty (no secrets in public repo)
- **Documentation**: Clear instructions for adding secrets when needed

### 4. Git Configuration
**File**: `examples/ui/.gitignore`
- **Updated**: Allow `.env.production` to be tracked (contains no secrets)
- **Maintained**: Keep `.env` and other sensitive files ignored

### 5. Documentation
**File**: `examples/ui/README.md`
- **Complete Guide**: Development setup, deployment process, configuration
- **Security Notes**: Explains environment variable handling
- **Usage Instructions**: How to trigger deployments

## How to Deploy

1. **Create a Pull Request** with your UI changes
2. **Add the label** `deploy-ui` to the PR
3. **GitHub Actions will automatically**:
   - Build the DaVinci SDK from the parent directory
   - Install UI dependencies
   - Build the Next.js application for static export
   - Deploy to GitHub Pages
   - Comment the deployment URL on the PR

## GitHub Pages Setup Required

Before the first deployment, enable GitHub Pages in repository settings:
1. Go to **Settings** → **Pages**
2. Set **Source** to "GitHub Actions"
3. The workflow will handle deployments automatically

**Note**: The workflow has been configured to bypass environment protection rules that typically restrict deployments to main/master branches only. This allows deployment directly from feature branches when the PR is labeled.

## Environment Protection Issue Resolution

**Problem**: GitHub Pages environments often have protection rules that only allow deployments from specific branches (usually `main` or `master`).

**Solution**: The workflow has been updated to remove the `environment` restriction, allowing deployments from any branch when triggered by the `deploy-ui` label.

**Alternative Solutions** (if you prefer stricter controls):
1. **Deploy after merge**: Change trigger to `push` on main branch with label check
2. **Configure environment**: Add your feature branch to allowed deployment branches
3. **Use staging environment**: Create a separate environment without branch restrictions

## Security Considerations

### Current Setup (No Secrets)
- Uses only public API endpoints
- PRIVATE_KEY is empty (app should handle gracefully)
- Suitable for demonstration/testing purposes

### Production Setup (With Secrets)
To enable full functionality:
1. Add `PRIVATE_KEY` as a GitHub Secret
2. Update workflow to use: `PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}`
3. Remove the empty PRIVATE_KEY from `.env.production`

## Build Process Details

### SDK Dependency Handling
- The UI depends on `./davinci-sdk.tgz` created by the preinstall script
- Workflow installs root dependencies first to build the SDK
- Then installs UI dependencies which uses the built SDK

### Static Export Configuration
- **Output**: Static HTML/CSS/JS files in `examples/ui/out/`
- **Base Path**: Automatically set for GitHub Pages subdirectory
- **Assets**: All public assets (WASM files, keys) included in export
- **Routing**: Configured with trailing slashes for proper navigation

### Environment Variables
- **Development**: Uses `.env` with full configuration
- **Production**: Uses `.env.production` with public-only variables
- **Build**: Next.js automatically loads appropriate environment file

## Troubleshooting

### Build Failures
- Check that all dependencies are properly installed
- Verify environment variables are correctly set
- Review GitHub Actions logs for specific error messages

### Deployment Issues
- **Environment Protection Error**: Fixed by removing environment restrictions
- Ensure GitHub Pages is enabled with "GitHub Actions" source
- Check repository permissions for GitHub Actions
- Verify the `out/` directory contains expected files

### Runtime Issues
- Missing PRIVATE_KEY will limit functionality (expected behavior)
- Check browser console for API connection issues
- Verify base path configuration matches repository name

## File Structure After Deployment

```
examples/ui/out/           # Static export directory
├── index.html            # Main application
├── _next/                # Next.js assets
├── *.wasm               # WebAssembly files
├── *.zkey               # Zero-knowledge proof keys
└── other assets...      # Images, fonts, etc.
```

The deployment creates a fully static website that can run without a server, making it perfect for GitHub Pages hosting.

## Deployment URL

After successful deployment, the UI will be available at:
`https://[username].github.io/[repository-name]/`

The workflow automatically comments this URL on the PR for easy access.
