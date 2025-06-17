import { Box, Container, Link, Typography } from '@mui/material';

export default function Footer() {
  return (
    <Box
      component="footer"
      sx={{
        py: 3,
        px: 2,
        mt: 'auto',
        backgroundColor: (theme) =>
          theme.palette.mode === 'light'
            ? theme.palette.grey[200]
            : theme.palette.grey[800],
      }}
    >
      <Container maxWidth="sm">
        <Typography variant="body2" color="text.secondary" align="center">
          {'© '}
          <Link color="inherit" href="https://davinci.vote/" target="_blank" rel="noopener noreferrer">
            DAVINCI
          </Link>{' '}
          {new Date().getFullYear()}
          {' - Powered by Davinci SDK'}
        </Typography>
      </Container>
    </Box>
  );
}
