import { createBrowserRouter, RouterProvider } from 'react-router'
import Home from './pages/Home'
import ProcessDetailPage from './pages/process-detail'
import ProcessesPage from './pages/processes'

const router = createBrowserRouter([
  {
    path: '/',
    Component: Home,
  },
  {
    path: '/processes',
    Component: ProcessesPage,
  },
  {
    path: '/process-detail/:id',
    Component: ProcessDetailPage,
  },
])

export const Router = () => <RouterProvider router={router} />
