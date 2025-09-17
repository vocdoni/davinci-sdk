# Contributing to Vocdoni DaVinci SDK

Thank you for your interest in contributing to the Vocdoni DaVinci SDK! We welcome contributions from the community and are grateful for your help in making this project better.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Issue Reporting](#issue-reporting)
- [Community](#community)

## 📜 Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to [info@vocdoni.io](mailto:info@vocdoni.io).

### Our Standards

- **Be respectful**: Treat everyone with respect and kindness
- **Be inclusive**: Welcome newcomers and help them get started
- **Be collaborative**: Work together towards common goals
- **Be constructive**: Provide helpful feedback and suggestions
- **Be patient**: Remember that everyone has different experience levels

## 🚀 Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (version 16 or higher)
- **Yarn** (recommended) or npm
- **Git**
- A code editor (VS Code recommended)

### First-time Setup

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/davinci-sdk.git
   cd davinci-sdk
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/vocdoni/davinci-sdk.git
   ```
4. **Install dependencies**:
   ```bash
   yarn install
   ```
5. **Run the tests** to ensure everything works:
   ```bash
   yarn test:unit
   ```

## 🛠 Development Setup

### Project Structure

```
davinci-sdk/
├── src/                    # Source code
│   ├── core/              # Core SDK functionality
│   ├── contracts/         # Smart contract interfaces
│   ├── sequencer/         # Sequencer API and crypto
│   └── census/            # Census management
├── test/                  # Test files
│   ├── unit/              # Unit tests
│   └── integration/       # Integration tests
├── examples/              # Usage examples
├── docs/                  # Documentation
└── dist/                  # Built files (generated)
```

### Available Scripts

```bash
# Development
yarn dev                   # Watch mode development build
yarn build                 # Production build
yarn clean                 # Clean build artifacts

# Testing
yarn test                  # Run all tests
yarn test:unit             # Run unit tests only
yarn test:integration      # Run integration tests only
yarn test:contracts        # Run contract tests
yarn test:sequencer        # Run sequencer tests
yarn test:census           # Run census tests

# Code Quality
yarn lint                  # Run ESLint
yarn lint:fix              # Fix ESLint issues
yarn format                # Format code with Prettier
yarn format:check          # Check code formatting

# Git Hooks
yarn lint-staged           # Run pre-commit checks
```

### Environment Setup

For integration tests, create a `.env` file in the `test/` directory:

```env
SEPOLIA_RPC=https://sepolia.infura.io/v3/your-key
PRIVATE_KEY=0x...
TIME_OUT=600000
```

## 🤝 How to Contribute

### Types of Contributions

We welcome various types of contributions:

- **🐛 Bug fixes**: Fix issues and improve stability
- **✨ New features**: Add new functionality to the SDK
- **📚 Documentation**: Improve docs, examples, and guides
- **🧪 Tests**: Add or improve test coverage
- **🔧 Tooling**: Improve development tools and processes
- **🎨 Examples**: Create new usage examples

### Before You Start

1. **Check existing issues** to see if your idea is already being worked on
2. **Create an issue** to discuss new features or major changes
3. **Ask questions** in our [Discord](https://chat.vocdoni.io) if you're unsure

### Making Changes

1. **Create a new branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

2. **Make your changes** following our coding standards

3. **Write or update tests** for your changes

4. **Update documentation** if needed

5. **Test your changes**:
   ```bash
   yarn test
   yarn lint
   yarn format:check
   ```

6. **Commit your changes** with a clear message:
   ```bash
   git commit -m "feat: add new voting method validation"
   # or
   git commit -m "fix: resolve census proof generation issue"
   ```

## 🔄 Pull Request Process

### Before Submitting

- [ ] Your code follows the project's coding standards
- [ ] You have added tests for your changes
- [ ] All tests pass locally
- [ ] You have updated documentation if necessary
- [ ] Your commits have clear, descriptive messages
- [ ] You have rebased your branch on the latest `main`

### Submitting a Pull Request

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** on GitHub with:
   - **Clear title** describing the change
   - **Detailed description** explaining what and why
   - **Link to related issues** if applicable
   - **Screenshots** for UI changes (if applicable)

3. **Respond to feedback** from reviewers promptly

### Pull Request Template

```markdown
## Description
Brief description of the changes made.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Checklist
- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
```

## 📏 Coding Standards

### TypeScript Guidelines

- **Use TypeScript** for all new code
- **Provide explicit types** for function parameters and return values
- **Use interfaces** for object shapes
- **Prefer `const` assertions** for immutable data
- **Use meaningful variable names**

```typescript
// Good
interface VoteConfig {
  processId: string;
  choices: number[];
  randomness?: string;
}

async function submitVote(config: VoteConfig): Promise<VoteResult> {
  // Implementation
}

// Avoid
function vote(p: string, c: number[], r?: string): Promise<any> {
  // Implementation
}
```

### Code Style

- **Use Prettier** for formatting (configured in `.prettierrc.json`)
- **Follow ESLint rules** (configured in `.eslintrc.json`)
- **Use 2 spaces** for indentation
- **Use semicolons**
- **Use single quotes** for strings
- **Use trailing commas** in multiline structures

### Error Handling

- **Use descriptive error messages**
- **Create custom error classes** when appropriate
- **Handle errors gracefully** in public APIs
- **Provide context** in error messages

```typescript
// Good
if (choices.length !== expectedLength) {
  throw new Error(`Expected ${expectedLength} choices, got ${choices.length}`);
}

// Avoid
if (choices.length !== expectedLength) {
  throw new Error('Invalid choices');
}
```

### Documentation

- **Use JSDoc comments** for public APIs
- **Include examples** in documentation
- **Document complex algorithms**
- **Keep comments up to date**

```typescript
/**
 * Submit a vote with simplified configuration
 * 
 * @param config - Vote configuration including process ID and choices
 * @returns Promise resolving to vote submission result
 * 
 * @example
 * ```typescript
 * const result = await sdk.submitVote({
 *   processId: "0x...",
 *   choices: [1, 0]
 * });
 * ```
 */
async submitVote(config: VoteConfig): Promise<VoteResult> {
  // Implementation
}
```

## 🧪 Testing Guidelines

### Test Structure

- **Unit tests**: Test individual functions and classes in isolation
- **Integration tests**: Test complete workflows and API interactions
- **Use descriptive test names** that explain what is being tested

### Writing Tests

```typescript
describe('VoteOrchestrationService', () => {
  describe('submitVote', () => {
    it('should submit a vote with valid configuration', async () => {
      // Arrange
      const config = { processId: '0x...', choices: [1] };
      
      // Act
      const result = await service.submitVote(config);
      
      // Assert
      expect(result.voteId).toBeDefined();
      expect(result.status).toBe(VoteStatus.Pending);
    });

    it('should throw error for invalid choices', async () => {
      // Arrange
      const config = { processId: '0x...', choices: [] };
      
      // Act & Assert
      await expect(service.submitVote(config)).rejects.toThrow('Expected 2 choices, got 0');
    });
  });
});
```

### Test Coverage

- **Aim for high test coverage** (>80%)
- **Test error conditions** as well as success cases
- **Mock external dependencies** in unit tests
- **Use real services** in integration tests when possible

## 📖 Documentation

### Types of Documentation

- **API Documentation**: JSDoc comments in code
- **Usage Examples**: In `examples/` directory
- **README**: High-level overview and quick start
- **Contributing Guide**: This document

### Documentation Standards

- **Keep it up to date** with code changes
- **Use clear, simple language**
- **Include practical examples**
- **Test code examples** to ensure they work

## 🐛 Issue Reporting

### Before Creating an Issue

1. **Search existing issues** to avoid duplicates
2. **Check the documentation** for solutions
3. **Try the latest version** to see if the issue is already fixed

### Creating a Good Issue

Include the following information:

- **Clear title** describing the problem
- **Steps to reproduce** the issue
- **Expected behavior**
- **Actual behavior**
- **Environment details** (Node.js version, OS, etc.)
- **Code samples** demonstrating the issue
- **Error messages** and stack traces

### Issue Templates

#### Bug Report
```markdown
**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Initialize SDK with '...'
2. Call method '....'
3. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Environment:**
- OS: [e.g. macOS, Windows, Linux]
- Node.js version: [e.g. 18.0.0]
- SDK version: [e.g. 0.0.2]

**Additional context**
Add any other context about the problem here.
```

#### Feature Request
```markdown
**Is your feature request related to a problem?**
A clear and concise description of what the problem is.

**Describe the solution you'd like**
A clear and concise description of what you want to happen.

**Describe alternatives you've considered**
A clear and concise description of any alternative solutions or features you've considered.

**Additional context**
Add any other context or screenshots about the feature request here.
```

## 🌟 Recognition

Contributors will be recognized in the following ways:

- **Contributors list** in the README
- **Release notes** mentioning significant contributions
- **Special thanks** in project announcements
- **Maintainer status** for consistent, high-quality contributions

## 💬 Community

### Getting Help

- **Discord**: [chat.vocdoni.io](https://chat.vocdoni.io) - Real-time chat
- **Telegram**: [t.me/vocdoni_community](https://t.me/vocdoni_community) - Community discussions
- **GitHub Issues**: For bug reports and feature requests
- **Email**: [info@vocdoni.io](mailto:info@vocdoni.io) - Direct contact

### Community Guidelines

- **Be welcoming** to newcomers
- **Help others** when you can
- **Share knowledge** and experiences
- **Provide constructive feedback**
- **Celebrate successes** together

## 📄 License

By contributing to this project, you agree that your contributions will be licensed under the same [MIT License](LICENSE) that covers the project.

---

Thank you for contributing to the Vocdoni DaVinci SDK! Your efforts help make decentralized voting more accessible to everyone. 🗳️✨
